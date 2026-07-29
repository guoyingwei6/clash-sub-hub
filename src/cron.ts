import { Env, GlobalSettings, UpstreamRuntimeState } from './types';
import { UpstreamDefinition } from './domain/config';
import { canAttemptRefresh, nextRetryAt } from './domain/cache-policy';
import { parseClashYaml } from './converter';
import { getGlobalSettings } from './settings';
import { loadActiveDesiredConfig } from './storage/config-state';
import {
  getUpstreamState,
  putUpstreamCache,
  putUpstreamState,
  upstreamSourceFingerprint,
} from './storage/upstream-cache';
import {
  MAX_PROVIDER_BYTES,
  readResponseTextLimited,
} from './limits';
import { rebuildDefaultMaterializedArtifact } from './subscription';

export interface RefreshSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  artifactReady: boolean;
}

export async function handleScheduled(
  env: Env,
  options: { force?: boolean } = {}
): Promise<RefreshSummary> {
  const settings = await getGlobalSettings(env);
  const config = await loadActiveDesiredConfig(env.KV);
  const upstreams = config.upstreams
    .filter((upstream) => upstream.fetchMode === 'server');
  const results = await Promise.allSettled(
    upstreams.map(
      (upstream) => fetchUpstream(upstream, settings, env, { force: options.force })
    )
  );

  if (results.some((result) => result.status === 'rejected')) {
    console.error('部分上游刷新状态写入失败');
  }
  const succeeded = results.filter(
    (result) => result.status === 'fulfilled' && !result.value.lastError
  ).length;
  const artifact = await rebuildDefaultMaterializedArtifact(env);
  return {
    attempted: upstreams.length,
    succeeded,
    failed: results.length - succeeded,
    artifactReady: artifact.ok,
  };
}

const FALLBACK_UAS = [
  'clash-verge/v2.2.3',
  'ClashforWindows/0.20.39',
  'clash.meta',
  'Stash/2.7.4 Clash/1.9.0',
  'Quantumult%20X/1.4.1 (iPhone16,2; iOS 18.0)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];
const MAX_UA_ATTEMPTS_PER_REFRESH = 2;

export async function fetchUpstream(
  upstream: UpstreamDefinition,
  settings: GlobalSettings,
  env: Env,
  options: { force?: boolean; now?: () => Date } = {}
): Promise<UpstreamRuntimeState> {
  const now = options.now?.() ?? new Date();
  const fingerprint = await upstreamSourceFingerprint(upstream);
  const previous = await getUpstreamState(env.KV, upstream);

  if (!canAttemptRefresh(previous, now, options.force)) {
    return previous!;
  }

  const timeout = (settings.fetchTimeout || 15) * 1000;
  const uaRaw = upstream.userAgent || settings.defaultUA || 'clash.meta';
  const configuredUas = uaRaw.split(',').map((value) => value.trim()).filter(Boolean);
  const allUAs = [...new Set([...configuredUas, ...FALLBACK_UAS])]
    .slice(0, MAX_UA_ATTEMPTS_PER_REFRESH);
  const errors: string[] = [];

  for (const userAgent of allUAs) {
    try {
      const response = await fetch(upstream.url, {
        headers: fetchHeaders(userAgent),
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });

      if (!response.ok) {
        errors.push(`${shortUserAgent(userAgent)}: HTTP ${response.status}`);
        continue;
      }

      const content = await readResponseTextLimited(response, MAX_PROVIDER_BYTES);
      const nodes = parseClashYaml(content);
      if (nodes.length === 0) {
        errors.push(`${shortUserAgent(userAgent)}: 200 但解析 0 节点`);
        continue;
      }

      const timestamp = now.toISOString();
      await putUpstreamCache(env.KV, {
        schemaVersion: 1,
        upstreamId: upstream.id,
        sourceFingerprint: fingerprint,
        updatedAt: timestamp,
        nodeCount: nodes.length,
        content,
      });
      const state: UpstreamRuntimeState = {
        upstreamId: upstream.id,
        lastAttemptAt: timestamp,
        lastSuccessAt: timestamp,
        cacheUpdatedAt: timestamp,
        nodeCount: nodes.length,
        lastError: null,
        consecutiveFailures: 0,
        nextRetryAt: null,
        sourceFingerprint: fingerprint,
      };
      await putUpstreamState(env.KV, state);
      return state;
    } catch (error) {
      errors.push(`${shortUserAgent(userAgent)}: ${safeFetchError(error)}`);
    }
  }

  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const state: UpstreamRuntimeState = {
    upstreamId: upstream.id,
    lastAttemptAt: now.toISOString(),
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    cacheUpdatedAt: previous?.cacheUpdatedAt ?? null,
    nodeCount: previous?.nodeCount ?? 0,
    lastError: `全部 ${allUAs.length} 个 UA 失败 (${errors.slice(0, 3).join('; ')})`,
    consecutiveFailures,
    nextRetryAt: nextRetryAt(now, consecutiveFailures),
    sourceFingerprint: fingerprint,
  };
  await putUpstreamState(env.KV, state);
  return state;
}

export async function testUpstreamUrl(
  url: string,
  userAgent: string
): Promise<{ ok: boolean; nodeCount: number; preview: string[]; error?: string }> {
  const uniqueUAs = [...new Set(
    [userAgent || 'clash.meta', ...FALLBACK_UAS]
      .map((value) => value.trim())
      .filter(Boolean)
  )].slice(0, MAX_UA_ATTEMPTS_PER_REFRESH);
  let lastError = '';

  for (const candidate of uniqueUAs) {
    try {
      const response = await fetch(url, {
        headers: fetchHeaders(candidate),
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }

      const nodes = parseClashYaml(await readResponseTextLimited(response, MAX_PROVIDER_BYTES));
      if (nodes.length === 0) {
        return { ok: false, nodeCount: 0, preview: [], error: '未解析到任何节点' };
      }
      return {
        ok: true,
        nodeCount: nodes.length,
        preview: nodes.slice(0, 10).map((node) => node.name),
      };
    } catch (error) {
      lastError = safeFetchError(error);
    }
  }

  return { ok: false, nodeCount: 0, preview: [], error: lastError || '所有 UA 均失败' };
}

function fetchHeaders(userAgent: string): Record<string, string> {
  const isBrowser = userAgent.startsWith('Mozilla/');
  const headers: Record<string, string> = {
    'User-Agent': userAgent,
    Accept: isBrowser
      ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      : '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (isBrowser) {
    headers['Cache-Control'] = 'no-cache';
    headers['Sec-Fetch-Dest'] = 'document';
    headers['Sec-Fetch-Mode'] = 'navigate';
    headers['Sec-Fetch-Site'] = 'none';
    headers['Upgrade-Insecure-Requests'] = '1';
  }
  return headers;
}

function shortUserAgent(userAgent: string): string {
  return userAgent.slice(0, 20);
}

function safeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return '网络错误';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return '连接超时';
  if (error.name === 'PayloadTooLargeError') return '响应内容过大';
  return '网络请求失败';
}
