import { Env, Upstream, GlobalSettings } from './types';
import { parseClashYaml } from './converter';
import { getGlobalSettings } from './settings';

export async function handleScheduled(env: Env): Promise<void> {
  // 同步外部脚本
  const scriptUrl = await env.KV.get('script-url');
  if (scriptUrl) {
    try {
      const resp = await fetch(scriptUrl, { signal: AbortSignal.timeout(15000) });
      if (resp.ok) {
        await env.KV.put('script-base', await resp.text());
      }
    } catch { /* 静默失败，保留旧脚本 */ }
  }

  const settings = await getGlobalSettings(env);

  // 同步上游订阅
  const raw = await env.KV.get('upstreams');
  if (!raw) return;

  const upstreams: Upstream[] = JSON.parse(raw);
  const updated: Upstream[] = [];

  // 跳过本地拉取模式的上游
  const results = await Promise.allSettled(
    upstreams.map((u) => u.localFetch ? Promise.resolve(u) : fetchUpstream(u, settings, env))
  );

  for (let i = 0; i < upstreams.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      updated.push(result.value);
    } else {
      updated.push({
        ...upstreams[i],
        lastError: result.reason?.message || '未知错误',
      });
    }
  }

  await env.KV.put('upstreams', JSON.stringify(updated));
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

export async function fetchUpstream(upstream: Upstream, settings: GlobalSettings, env: Env): Promise<Upstream> {
  const timeout = (settings.fetchTimeout || 15) * 1000;
  const uaRaw = upstream.userAgent || settings.defaultUA || 'clash.meta';
  const uas = uaRaw.split(',').map(s => s.trim()).filter(Boolean);
  // 合并用户 UA + 备选 UA，去重
  const allUAs = [...new Set([...uas, ...FALLBACK_UAS])];

  const errors: string[] = [];
  for (const ua of allUAs) {
    try {
      const isBrowser = ua.startsWith('Mozilla/');
      const headers: Record<string, string> = {
        'User-Agent': ua,
        'Accept': isBrowser
          ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          : '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      };
      if (isBrowser) {
        headers['Cache-Control'] = 'no-cache';
        headers['Sec-Fetch-Dest'] = 'document';
        headers['Sec-Fetch-Mode'] = 'navigate';
        headers['Sec-Fetch-Site'] = 'none';
        headers['Upgrade-Insecure-Requests'] = '1';
      }
      const resp = await fetch(upstream.url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });

      if (resp.ok) {
        const text = await resp.text();
        const nodes = parseClashYaml(text);
        if (nodes.length === 0) {
          errors.push(`${ua.slice(0, 20)}: 200 但解析 0 节点`);
          continue;
        }
        await env.KV.put(`cache:${upstream.name}`, text);
        return {
          ...upstream,
          localFetch: false,
          lastUpdate: new Date().toISOString(),
          nodeCount: nodes.length,
          lastError: null,
        };
      }
      errors.push(`${ua.slice(0, 20)}: HTTP ${resp.status}`);
    } catch (e) {
      errors.push(`${ua.slice(0, 20)}: ${(e as Error).message?.slice(0, 30) || '网络错误'}`);
    }
  }

  // 只保留前3条错误详情，避免太长
  const detail = errors.slice(0, 3).join('; ');
  return {
    ...upstream,
    localFetch: true,
    lastError: `全部 ${allUAs.length} 个 UA 失败，已切换本地拉取 (${detail})`,
  };
}

export async function testUpstreamUrl(
  url: string,
  userAgent: string
): Promise<{ ok: boolean; nodeCount: number; preview: string[]; error?: string }> {
  const uas = [userAgent || 'clash.meta', ...FALLBACK_UAS];
  const uniqueUAs = [...new Set(uas.map(s => s.trim()).filter(Boolean))];
  let lastError = '';

  for (const ua of uniqueUAs) {
    try {
      const isBrowser = ua.startsWith('Mozilla/');
      const headers: Record<string, string> = {
        'User-Agent': ua,
        'Accept': isBrowser
          ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          : '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      };
      if (isBrowser) {
        headers['Cache-Control'] = 'no-cache';
        headers['Sec-Fetch-Dest'] = 'document';
        headers['Sec-Fetch-Mode'] = 'navigate';
        headers['Sec-Fetch-Site'] = 'none';
        headers['Upgrade-Insecure-Requests'] = '1';
      }
      const resp = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        lastError = `HTTP ${resp.status}`;
        continue;
      }

      const text = await resp.text();
      const nodes = parseClashYaml(text);

      if (nodes.length === 0) {
        return { ok: false, nodeCount: 0, preview: [], error: '未解析到任何节点' };
      }

      return {
        ok: true,
        nodeCount: nodes.length,
        preview: nodes.slice(0, 10).map((n) => n.name),
      };
    } catch (e) {
      lastError = (e as Error).message;
    }
  }

  return { ok: false, nodeCount: 0, preview: [], error: lastError || '所有 UA 均失败' };
}
