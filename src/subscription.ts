import { Env, User, Upstream, ProxyNode } from './types';
import yaml from 'js-yaml';
import {
  parseClashYaml,
  filterNodes,
  deduplicateNodes,
  nodesToBase64,
} from './converter';
import { getGlobalSettings } from './settings';
import { runBuiltinScript } from './clashverge-script';

export async function handleSubscription(
  token: string,
  format: string | null,
  mode: string | null,
  env: Env
): Promise<Response> {
  const userResult = await resolveUser(token, env);
  if (userResult.response) return userResult.response;
  const user = userResult.user!;

  const wantsMaterialized = isMaterializedMode(mode) || format === 'base64' || mode === 'nodes';
  const data = await collectSubscriptionData(user, env, { includeCachedNodes: wantsMaterialized });
  const outputNodes = wantsMaterialized ? data.materializedNodes : data.customNodes;

  // base64 格式：输出可转换为 URI 的已物化节点，适合 Shadowrocket 等客户端。
  if (format === 'base64') {
    return new Response(nodesToBase64(outputNodes), {
      headers: subscriptionHeaders('text/plain; charset=utf-8', 'proxies'),
    });
  }

  // 纯节点模式：输出已物化的 proxies，不跑脚本、不加规则。
  if (mode === 'nodes') {
    const nodesConfig = yaml.dump({ proxies: outputNodes }, { lineWidth: -1, noRefs: true });
    return new Response(nodesConfig, {
      headers: subscriptionHeaders('text/yaml; charset=utf-8', 'nodes.yaml'),
    });
  }

  // 物化模式：Worker 使用缓存的上游节点 + 自建节点生成完整 Mihomo YAML，不依赖 Clash Verge Merge。
  if (isMaterializedMode(mode)) {
    const fullConfig = await buildFullConfig(outputNodes, [], env);
    return new Response(fullConfig, {
      headers: subscriptionHeaders('text/yaml; charset=utf-8', 'clash_sub_hub_materialized.yaml'),
    });
  }

  // 默认/full 模式：保留原 Clash Verge 高级玩法，输出 proxy-providers + 自建节点 + 脚本规则。
  const fullConfig = await buildFullConfig(data.customNodes, data.providers, env);
  return new Response(fullConfig, {
    headers: subscriptionHeaders('text/yaml; charset=utf-8', 'clash_sub_hub.yaml'),
  });
}

export async function handleMerge(token: string, env: Env): Promise<Response> {
  const userResult = await resolveUser(token, env);
  if (userResult.response) return userResult.response;

  const data = await collectSubscriptionData(userResult.user!, env, { includeCachedNodes: false });
  const mergeConfig = buildMergeConfig(data.customNodes, data.providers);

  return new Response(mergeConfig, {
    headers: subscriptionHeaders('text/yaml; charset=utf-8', 'merge.yaml'),
  });
}

interface ProviderInfo {
  name: string;
  url: string;
  userAgent: string;
  prefix: string;
  exclude?: string;
}

type SubscriptionData = {
  customNodes: ProxyNode[];
  providers: ProviderInfo[];
  materializedNodes: ProxyNode[];
};

async function resolveUser(token: string, env: Env): Promise<{ user?: User; response?: Response }> {
  const usersRaw = await env.KV.get('users');
  if (!usersRaw) return { response: new Response('未找到用户', { status: 403 }) };

  const users: User[] = JSON.parse(usersRaw);
  const user = users.find((u) => u.token === token);
  if (!user) return { response: new Response('无效的订阅链接', { status: 403 }) };
  if (!user.enabled) return { response: new Response('订阅已被禁用', { status: 403 }) };

  return { user };
}

async function collectSubscriptionData(
  user: User,
  env: Env,
  options: { includeCachedNodes: boolean }
): Promise<SubscriptionData> {
  const upstreamsRaw = await env.KV.get('upstreams');
  let upstreams: Upstream[] = upstreamsRaw ? JSON.parse(upstreamsRaw) : [];

  const settings = await getGlobalSettings(env);
  const shouldFilter = user.filterNodes != null ? user.filterNodes : settings.filterEnabled;

  if (user.allowedUpstreams != null) {
    upstreams = upstreams.filter((u) => user.allowedUpstreams!.includes(u.name));
  }

  const providers: ProviderInfo[] = [];
  const cachedNodes: ProxyNode[] = [];

  for (const upstream of upstreams) {
    const prefix = upstream.prefix === undefined ? `${upstream.name} | ` : (upstream.prefix ? `${upstream.prefix} | ` : '');
    const provider: ProviderInfo = {
      name: upstream.name,
      url: upstream.url,
      userAgent: upstream.userAgent || settings.defaultUA,
      prefix,
      exclude: upstream.exclude,
    };
    providers.push(provider);

    if (!options.includeCachedNodes) continue;
    const cache = await env.KV.get(`cache:${upstream.name}`);
    if (!cache) continue;

    let nodes = parseClashYaml(cache);
    if (shouldFilter) nodes = filterNodes(nodes);
    nodes = applyProviderExclude(nodes, provider.exclude);
    cachedNodes.push(...nodes.map((node) => applyProviderPrefix(node, prefix)));
  }

  let customNodes: ProxyNode[] = [];
  const customRaw = await env.KV.get('custom-nodes');
  if (customRaw) {
    customNodes = JSON.parse(customRaw);
    if (user.allowedCustomNodes != null) {
      customNodes = customNodes.filter((n) => user.allowedCustomNodes!.includes(n.name));
    }
  }

  if (shouldFilter) customNodes = filterNodes(customNodes);

  return {
    customNodes: deduplicateNodes(customNodes),
    providers,
    materializedNodes: deduplicateNodes([...cachedNodes, ...customNodes]),
  };
}

function applyProviderExclude(nodes: ProxyNode[], exclude?: string) {
  if (!exclude) return nodes;
  try {
    const re = new RegExp(exclude);
    return nodes.filter((node) => !re.test(node.name));
  } catch {
    return nodes;
  }
}

function applyProviderPrefix(node: ProxyNode, prefix: string): ProxyNode {
  if (!prefix || node.name.startsWith(prefix)) return { ...node };
  return { ...node, name: `${prefix}${node.name}` };
}

function buildMergeConfig(customNodes: ProxyNode[], providers: ProviderInfo[]): string {
  const proxyProviders: Record<string, unknown> = {};
  for (const p of providers) {
    const provider: Record<string, unknown> = {
      type: 'http',
      url: p.url,
      interval: 3600,
      path: `./providers/${p.name}.yaml`,
      'health-check': {
        enable: true,
        interval: 600,
        url: 'https://www.gstatic.com/generate_204',
      },
      header: { 'User-Agent': [p.userAgent, 'Mihomo'] },
    };
    if (p.prefix) provider.override = { 'additional-prefix': p.prefix };
    if (p.exclude) provider['exclude-filter'] = p.exclude;
    proxyProviders[p.name] = provider;
  }

  const doc: Record<string, unknown> = {};
  if (Object.keys(proxyProviders).length > 0) doc['proxy-providers'] = proxyProviders;
  if (customNodes.length > 0) doc.proxies = customNodes;
  return yaml.dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"' });
}

function isMaterializedMode(mode: string | null): boolean {
  return mode === 'materialized' || mode === 'yaml' || mode === 'direct';
}

async function buildFullConfig(
  proxies: ProxyNode[],
  providers: ProviderInfo[],
  env: Env
): Promise<string> {
  const overrideScript = await env.KV.get('script-override') || '';

  const proxyProviders: Record<string, unknown> = {};
  for (const p of providers) {
    const provider: Record<string, unknown> = {
      type: 'http',
      url: p.url,
      interval: 3600,
      path: `./providers/${p.name}.yaml`,
      'health-check': {
        enable: true,
        url: 'http://connectivitycheck.gstatic.com/generate_204',
        interval: 300,
      },
      header: { 'User-Agent': [p.userAgent] },
    };
    if (p.prefix) {
      provider.override = { 'additional-prefix': p.prefix };
    }
    if (p.exclude) {
      provider['exclude-filter'] = p.exclude;
    }
    proxyProviders[p.name] = provider;
  }

  let config: Record<string, unknown> = {
    proxies,
    'proxy-groups': [],
    'proxy-providers': proxyProviders,
    'rule-providers': {},
    rules: [],
  };

  try {
    const result = runBuiltinScript(config);
    if (result && typeof result === 'object') config = result;
  } catch (e) {
    console.error('内置脚本执行失败:', e);
  }

  if (overrideScript) {
    try {
      const result = executeScript(overrideScript, config);
      if (result) config = result;
    } catch (e) {
      console.error('自定义脚本执行失败:', e);
    }
  }

  injectMaterializedNodesIntoProviderGroups(config);

  return yaml.dump(config, { lineWidth: -1, noRefs: true });
}

function injectMaterializedNodesIntoProviderGroups(config: Record<string, unknown>) {
  const allProxyNames = ((config.proxies as ProxyNode[]) || []).map((p) => p.name);
  const groups = config['proxy-groups'] as Record<string, unknown>[] | undefined;
  if (!groups || !Array.isArray(groups) || allProxyNames.length === 0) return;

  for (const group of groups) {
    if (!('use' in group)) continue;
    const existing = (group.proxies as string[]) || [];
    const filter = group.filter as string | undefined;
    let namesToAdd = allProxyNames;
    if (filter) {
      try {
        const re = new RegExp(filter);
        namesToAdd = namesToAdd.filter((n) => re.test(n));
      } catch { /* 无效正则，跳过过滤 */ }
    }
    group.proxies = [...new Set([...existing, ...namesToAdd])];
  }
}

function subscriptionHeaders(contentType: string, filename: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename=${filename}`,
    'Profile-Update-Interval': '1',
    'Cache-Control': 'no-store',
  };
}

function executeScript(
  scriptText: string,
  config: Record<string, unknown>
): Record<string, unknown> | null {
  const fn = new Function(
    'config',
    `${scriptText};
if (typeof main === 'function') return main(config); return config;`
  );
  const result = fn(config);
  return result && typeof result === 'object' ? result : null;
}
