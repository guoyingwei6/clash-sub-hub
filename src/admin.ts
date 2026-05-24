import { Env, User, Upstream, ProxyNode } from './types';
import { testUpstreamUrl } from './cron';
import { handleScheduled } from './cron';
import yaml from 'js-yaml';

// ==================== 用户管理 ====================

export async function listUsers(env: Env): Promise<Response> {
  const raw = await env.KV.get('users');
  return Response.json(raw ? JSON.parse(raw) : []);
}

export async function createUser(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { token: string; name: string };
  if (!body.token || !body.name) {
    return Response.json({ error: 'token 和 name 必填' }, { status: 400 });
  }

  const raw = await env.KV.get('users');
  const users: User[] = raw ? JSON.parse(raw) : [];

  if (users.some((u) => u.token === body.token)) {
    return Response.json({ error: 'token 已存在' }, { status: 409 });
  }

  users.push({
    token: body.token,
    name: body.name,
    enabled: true,
    createdAt: new Date().toISOString(),
  });

  await env.KV.put('users', JSON.stringify(users));
  return Response.json({ ok: true });
}

export async function updateUser(token: string, request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { enabled?: boolean; name?: string };
  const raw = await env.KV.get('users');
  if (!raw) return Response.json({ error: '用户不存在' }, { status: 404 });

  const users: User[] = JSON.parse(raw);
  const user = users.find((u) => u.token === token);
  if (!user) return Response.json({ error: '用户不存在' }, { status: 404 });

  if (body.enabled !== undefined) user.enabled = body.enabled;
  if (body.name !== undefined) user.name = body.name;

  await env.KV.put('users', JSON.stringify(users));
  return Response.json({ ok: true });
}

export async function deleteUser(token: string, env: Env): Promise<Response> {
  const raw = await env.KV.get('users');
  if (!raw) return Response.json({ error: '用户不存在' }, { status: 404 });

  const users: User[] = JSON.parse(raw);
  const filtered = users.filter((u) => u.token !== token);

  if (filtered.length === users.length) {
    return Response.json({ error: '用户不存在' }, { status: 404 });
  }

  await env.KV.put('users', JSON.stringify(filtered));
  return Response.json({ ok: true });
}

// ==================== 上游订阅管理 ====================

export async function listUpstreams(env: Env): Promise<Response> {
  const raw = await env.KV.get('upstreams');
  return Response.json(raw ? JSON.parse(raw) : []);
}

export async function createUpstream(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { name: string; url: string; userAgent?: string };
  if (!body.name || !body.url) {
    return Response.json({ error: 'name 和 url 必填' }, { status: 400 });
  }

  const raw = await env.KV.get('upstreams');
  const upstreams: Upstream[] = raw ? JSON.parse(raw) : [];

  if (upstreams.some((u) => u.name === body.name)) {
    return Response.json({ error: '名称已存在' }, { status: 409 });
  }

  upstreams.push({
    name: body.name,
    url: body.url,
    userAgent: body.userAgent || 'clash.meta',
    lastUpdate: null,
    nodeCount: 0,
    lastError: null,
  });

  await env.KV.put('upstreams', JSON.stringify(upstreams));
  return Response.json({ ok: true });
}

export async function updateUpstream(
  name: string,
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as { url?: string; userAgent?: string };
  const raw = await env.KV.get('upstreams');
  if (!raw) return Response.json({ error: '不存在' }, { status: 404 });

  const upstreams: Upstream[] = JSON.parse(raw);
  const upstream = upstreams.find((u) => u.name === name);
  if (!upstream) return Response.json({ error: '不存在' }, { status: 404 });

  if (body.url !== undefined) upstream.url = body.url;
  if (body.userAgent !== undefined) upstream.userAgent = body.userAgent;

  await env.KV.put('upstreams', JSON.stringify(upstreams));
  return Response.json({ ok: true });
}

export async function deleteUpstream(name: string, env: Env): Promise<Response> {
  const raw = await env.KV.get('upstreams');
  if (!raw) return Response.json({ error: '不存在' }, { status: 404 });

  const upstreams: Upstream[] = JSON.parse(raw);
  const filtered = upstreams.filter((u) => u.name !== name);

  await env.KV.put('upstreams', JSON.stringify(filtered));
  await env.KV.delete(`cache:${name}`);
  return Response.json({ ok: true });
}

export async function testUpstream(request: Request): Promise<Response> {
  const body = (await request.json()) as { url: string; userAgent?: string };
  if (!body.url) return Response.json({ error: 'url 必填' }, { status: 400 });

  const result = await testUpstreamUrl(body.url, body.userAgent || 'clash.meta');
  return Response.json(result);
}

export async function testExistingUpstream(name: string, env: Env): Promise<Response> {
  const raw = await env.KV.get('upstreams');
  if (!raw) return Response.json({ error: '不存在' }, { status: 404 });

  const upstreams: Upstream[] = JSON.parse(raw);
  const upstream = upstreams.find((u) => u.name === name);
  if (!upstream) return Response.json({ error: '不存在' }, { status: 404 });

  const result = await testUpstreamUrl(upstream.url, upstream.userAgent);
  return Response.json(result);
}

export async function refreshAll(env: Env): Promise<Response> {
  await handleScheduled(env);
  return Response.json({ ok: true });
}

// ==================== 自建节点管理 ====================

export async function listCustomNodes(env: Env): Promise<Response> {
  const raw = await env.KV.get('custom-nodes');
  return Response.json(raw ? JSON.parse(raw) : []);
}

export async function createCustomNode(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { yaml: string };
  if (!body.yaml) return Response.json({ error: 'yaml 必填' }, { status: 400 });

  let node: ProxyNode;
  try {
    node = yaml.load(body.yaml) as ProxyNode;
    if (!node.name || !node.type || !node.server || !node.port) {
      return Response.json({ error: '节点缺少必要字段 (name, type, server, port)' }, { status: 400 });
    }
  } catch {
    return Response.json({ error: 'YAML 解析失败' }, { status: 400 });
  }

  const raw = await env.KV.get('custom-nodes');
  const nodes: ProxyNode[] = raw ? JSON.parse(raw) : [];

  if (nodes.some((n) => n.name === node.name)) {
    return Response.json({ error: '节点名已存在' }, { status: 409 });
  }

  nodes.push(node);
  await env.KV.put('custom-nodes', JSON.stringify(nodes));
  return Response.json({ ok: true });
}

export async function updateCustomNode(
  name: string,
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as { yaml: string };
  if (!body.yaml) return Response.json({ error: 'yaml 必填' }, { status: 400 });

  let node: ProxyNode;
  try {
    node = yaml.load(body.yaml) as ProxyNode;
    if (!node.name || !node.type || !node.server || !node.port) {
      return Response.json({ error: '节点缺少必要字段' }, { status: 400 });
    }
  } catch {
    return Response.json({ error: 'YAML 解析失败' }, { status: 400 });
  }

  const raw = await env.KV.get('custom-nodes');
  if (!raw) return Response.json({ error: '不存在' }, { status: 404 });

  const nodes: ProxyNode[] = JSON.parse(raw);
  const idx = nodes.findIndex((n) => n.name === name);
  if (idx === -1) return Response.json({ error: '不存在' }, { status: 404 });

  nodes[idx] = node;
  await env.KV.put('custom-nodes', JSON.stringify(nodes));
  return Response.json({ ok: true });
}

export async function deleteCustomNode(name: string, env: Env): Promise<Response> {
  const raw = await env.KV.get('custom-nodes');
  if (!raw) return Response.json({ error: '不存在' }, { status: 404 });

  const nodes: ProxyNode[] = JSON.parse(raw);
  const filtered = nodes.filter((n) => n.name !== name);

  await env.KV.put('custom-nodes', JSON.stringify(filtered));
  return Response.json({ ok: true });
}

// ==================== 脚本管理 ====================

export async function getScript(env: Env): Promise<Response> {
  const script = await env.KV.get('script');
  return Response.json({ script: script || '' });
}

export async function updateScript(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { script: string };
  await env.KV.put('script', body.script || '');
  return Response.json({ ok: true });
}

// ==================== 导入导出 ====================

export async function importMerge(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { yaml: string };
  if (!body.yaml) return Response.json({ error: 'yaml 必填' }, { status: 400 });

  let doc: Record<string, unknown>;
  try {
    doc = yaml.load(body.yaml) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'YAML 解析失败' }, { status: 400 });
  }

  let upstreamCount = 0;
  let nodeCount = 0;

  // 解析 proxy-providers → upstreams
  const providers = doc['proxy-providers'] as Record<string, Record<string, unknown>> | undefined;
  if (providers) {
    const raw = await env.KV.get('upstreams');
    const existing: Upstream[] = raw ? JSON.parse(raw) : [];
    const existingNames = new Set(existing.map(u => u.name));

    for (const [name, provider] of Object.entries(providers)) {
      if (existingNames.has(name)) continue;
      const url = provider.url as string;
      if (!url) continue;
      const headers = provider.header as Record<string, unknown> | undefined;
      let userAgent = 'clash.meta';
      if (headers?.['User-Agent']) {
        const ua = headers['User-Agent'];
        userAgent = Array.isArray(ua) ? ua[0] : String(ua);
      }
      existing.push({
        name, url, userAgent,
        lastUpdate: null, nodeCount: 0, lastError: null,
      });
      upstreamCount++;
    }
    await env.KV.put('upstreams', JSON.stringify(existing));
  }

  // 解析 proxies → custom-nodes
  const proxies = doc.proxies as ProxyNode[] | undefined;
  if (proxies && Array.isArray(proxies)) {
    const raw = await env.KV.get('custom-nodes');
    const existing: ProxyNode[] = raw ? JSON.parse(raw) : [];
    const existingNames = new Set(existing.map(n => n.name));

    for (const node of proxies) {
      if (!node.name || existingNames.has(node.name)) continue;
      existing.push(node);
      existingNames.add(node.name);
      nodeCount++;
    }
    await env.KV.put('custom-nodes', JSON.stringify(existing));
  }

  return Response.json({ ok: true, upstreamCount, nodeCount });
}

export async function exportMerge(env: Env): Promise<Response> {
  // 重建 proxy-providers
  const upRaw = await env.KV.get('upstreams');
  const upstreams: Upstream[] = upRaw ? JSON.parse(upRaw) : [];
  const providers: Record<string, unknown> = {};
  for (const u of upstreams) {
    providers[u.name] = {
      type: 'http',
      url: u.url,
      interval: 3600,
      path: `./providers/${u.name}.yaml`,
      'health-check': { enable: true, interval: 600, url: 'https://www.gstatic.com/generate_204' },
      override: { 'additional-prefix': `${u.name} | ` },
      header: { 'User-Agent': [u.userAgent, 'Mihomo'] },
    };
  }

  // 重建 proxies
  const nodeRaw = await env.KV.get('custom-nodes');
  const nodes: ProxyNode[] = nodeRaw ? JSON.parse(nodeRaw) : [];

  const doc: Record<string, unknown> = {};
  if (Object.keys(providers).length > 0) doc['proxy-providers'] = providers;
  if (nodes.length > 0) doc['proxies'] = nodes;

  const yamlText = yaml.dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"' });
  return new Response(yamlText, {
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="merge.yaml"',
    },
  });
}
