import { Env, Upstream } from './types';
import { parseClashYaml } from './converter';

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

  // 同步上游订阅
  const raw = await env.KV.get('upstreams');
  if (!raw) return;

  const upstreams: Upstream[] = JSON.parse(raw);
  const updated: Upstream[] = [];

  const results = await Promise.allSettled(
    upstreams.map((u) => fetchUpstream(u, env))
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

async function fetchUpstream(upstream: Upstream, env: Env): Promise<Upstream> {
  const resp = await fetch(upstream.url, {
    headers: { 'User-Agent': upstream.userAgent || 'clash.meta' },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    return {
      ...upstream,
      lastError: `HTTP ${resp.status}`,
    };
  }

  const text = await resp.text();
  const nodes = parseClashYaml(text);

  await env.KV.put(`cache:${upstream.name}`, text);

  return {
    ...upstream,
    lastUpdate: new Date().toISOString(),
    nodeCount: nodes.length,
    lastError: null,
  };
}

export async function testUpstreamUrl(
  url: string,
  userAgent: string
): Promise<{ ok: boolean; nodeCount: number; preview: string[]; error?: string }> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': userAgent || 'clash.meta' },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      return { ok: false, nodeCount: 0, preview: [], error: `HTTP ${resp.status}` };
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
    return { ok: false, nodeCount: 0, preview: [], error: (e as Error).message };
  }
}
