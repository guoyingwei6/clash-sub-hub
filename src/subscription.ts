import { Env, User, ProxyNode } from './types';
import { stringifyYaml } from './yaml';
import {
  parseClashYaml,
  filterNodes,
  deduplicateNodes,
  nodesToBase64,
} from './converter';
import { getGlobalSettings } from './settings';
import { runBuiltinScript } from './clashverge-script';
import {
  ConfigConflictError,
  loadActiveDesiredConfig,
  publishDesiredConfig,
  toDraft,
} from './storage/config-state';
import { getUpstreamCache } from './storage/upstream-cache';
import { cacheAgeSeconds } from './domain/cache-policy';
import { hashSubscriptionToken } from './domain/token';
import { isReservedProxyName } from './domain/reserved-names';
import {
  DesiredConfigDraft,
  DesiredConfigV2,
  MaterializedArtifact,
  MaterializedPolicy,
} from './domain/config';

const MAX_MATERIALIZED_ARTIFACT_BYTES = 20 * 1024 * 1024;

export async function handleSubscription(
  token: string,
  format: string | null,
  mode: string | null,
  env: Env
): Promise<Response> {
  const userResult = await resolveUser(token, env);
  if (userResult.response) return userResult.response;
  const user = userResult.user!;

  const wantsProviderMode = mode === 'provider' || mode === 'full';
  if (wantsProviderMode && user.allowProviderMode !== true) {
    return new Response('此订阅不允许 Provider 模式', {
      status: 403,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  const wantsMaterialized = format === 'base64' || mode === 'nodes' || !wantsProviderMode;
  let config: DesiredConfigV2;
  try {
    config = await loadActiveDesiredConfig(env.KV);
  } catch {
    return new Response('订阅生成失败', {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  const canUseDefaultArtifact = wantsMaterialized
    && format !== 'base64'
    && mode !== 'nodes'
    && user.allowedUpstreams == null
    && user.allowedCustomNodes == null
    && user.filterNodes == null;
  if (
    canUseDefaultArtifact
    && config.materializedArtifact
    && artifactIsUsable(config)
  ) {
    return materializedResponse(config.materializedArtifact.yaml, 'hit');
  }

  let data: SubscriptionData;
  try {
    data = await collectSubscriptionData(
      user,
      env,
      { includeCachedNodes: wantsMaterialized },
      config
    );
  } catch (error) {
    if (error instanceof MaterializationError) {
      return new Response(error.message, {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    console.error('订阅数据准备失败');
    return new Response('订阅生成失败', {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  const outputNodes = wantsMaterialized ? data.materializedNodes : data.customNodes;

  // base64 格式：输出可转换为 URI 的已物化节点，适合 Shadowrocket 等客户端。
  if (format === 'base64') {
    return new Response(nodesToBase64(outputNodes), {
      headers: subscriptionHeaders('text/plain; charset=utf-8', 'proxies'),
    });
  }

  // 纯节点模式：输出已物化的 proxies，不跑脚本、不加规则。
  if (mode === 'nodes') {
    const nodesConfig = stringifyYaml({ proxies: outputNodes });
    return new Response(nodesConfig, {
      headers: subscriptionHeaders('text/yaml; charset=utf-8', 'nodes.yaml'),
    });
  }

  // 物化模式：Worker 使用缓存的上游节点 + 自建节点生成完整 Mihomo YAML，不依赖 Clash Verge Merge。
  if (wantsMaterialized) {
    const fullConfig = await safeBuildFullConfig(
      outputNodes,
      [],
      env,
      config.policy,
      data.customNodes.map((node) => node.name),
      true
    );
    if (fullConfig instanceof Response) return fullConfig;
    if (canUseDefaultArtifact) {
      await opportunisticallyBundleArtifact(config, fullConfig, env);
    }
    return materializedResponse(fullConfig, 'miss');
  }

  // provider/full 模式是显式降级路径，会把原始上游 URL 交给客户端。
  const fullConfig = await safeBuildFullConfig(
    data.customNodes,
    data.providers,
    env,
    config.policy,
    data.customNodes.map((node) => node.name),
    false
  );
  if (fullConfig instanceof Response) return fullConfig;
  return new Response(fullConfig, {
    headers: subscriptionHeaders('text/yaml; charset=utf-8', 'clash_sub_hub.yaml'),
  });
}

function artifactIsUsable(config: DesiredConfigV2): boolean {
  const artifact = config.materializedArtifact;
  if (!artifact) return false;
  if (config.policy.missingCache === 'serve-stale') return true;
  return cacheAgeSeconds(artifact.generatedAt, new Date())
    <= config.policy.maxCacheAgeSeconds;
}

export async function handleMerge(token: string, env: Env): Promise<Response> {
  const userResult = await resolveUser(token, env);
  if (userResult.response) return userResult.response;
  if (userResult.user!.allowProviderMode !== true) {
    return new Response('此订阅不允许 Merge 模式', {
      status: 403,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const config = await loadActiveDesiredConfig(env.KV);
  const data = await collectSubscriptionData(
    userResult.user!,
    env,
    { includeCachedNodes: false },
    config
  );
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

class MaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterializationError';
  }
}

async function resolveUser(token: string, env: Env): Promise<{ user?: User; response?: Response }> {
  const usersRaw = await env.KV.get('users');
  if (!usersRaw) return { response: new Response('无效的订阅链接', { status: 403 }) };

  const users: User[] = JSON.parse(usersRaw);
  const tokenHash = await hashSubscriptionToken(token);
  const user = users.find((candidate) => candidate.tokenHash
    ? constantTimeStringEqual(candidate.tokenHash, tokenHash)
    : candidate.token ? constantTimeStringEqual(candidate.token, token) : false);
  if (!user || !user.enabled) {
    return { response: new Response('无效的订阅链接', { status: 403 }) };
  }

  return { user };
}

function constantTimeStringEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function collectSubscriptionData(
  user: User,
  env: Env,
  options: { includeCachedNodes: boolean },
  config: DesiredConfigDraft
): Promise<SubscriptionData> {
  let upstreams = config.upstreams;

  const settings = await getGlobalSettings(env);
  const shouldFilter = user.filterNodes != null
    ? user.filterNodes
    : config.policy.filterUpstreamInfoNodes;

  if (user.allowedUpstreams != null) {
    upstreams = upstreams.filter((u) => user.allowedUpstreams!.includes(u.name));
  }

  const providers: ProviderInfo[] = [];
  const cachedNodes: ProxyNode[] = [];

  for (const upstream of upstreams) {
    if (upstream.fetchMode === 'disabled') continue;
    const prefix = upstream.prefix;
    const provider: ProviderInfo = {
      name: upstream.name,
      url: upstream.url,
      userAgent: upstream.userAgent || settings.defaultUA,
      prefix,
      exclude: upstream.exclude,
    };
    providers.push(provider);

    if (!options.includeCachedNodes) continue;
    const cache = await getUpstreamCache(env.KV, upstream);
    if (!cache) {
      if (upstream.required) {
        throw new MaterializationError('完整配置暂不可用：必需上游尚无有效缓存');
      }
      continue;
    }
    const stale = cacheAgeSeconds(cache.updatedAt, new Date()) > config.policy.maxCacheAgeSeconds;
    if (stale && config.policy.missingCache === 'fail') {
      if (upstream.required) {
        throw new MaterializationError('完整配置暂不可用：必需上游缓存已经过期');
      }
      continue;
    }

    let nodes = parseClashYaml(cache.content);
    if (shouldFilter) nodes = filterNodes(nodes);
    nodes = applyProviderExclude(nodes, provider.exclude);
    cachedNodes.push(...nodes.map((node) => applyProviderPrefix(node, prefix)));
  }

  let customNodes: ProxyNode[] = config.customNodes;
  if (user.allowedCustomNodes != null) {
    customNodes = customNodes.filter((n) => user.allowedCustomNodes!.includes(n.name));
  }
  customNodes = deduplicateNodes(customNodes);
  if (customNodes.some((node) => isReservedProxyName(node.name))) {
    throw new MaterializationError('完整配置暂不可用：自建节点名称与内置分组冲突');
  }
  const trustedNames = new Set(customNodes.map((node) => node.name));
  const safeCachedNodes = cachedNodes.filter(
    (node) => !trustedNames.has(node.name) && !isReservedProxyName(node.name)
  );
  const materializedNodes = deduplicateNodes([...safeCachedNodes, ...customNodes]);
  if (options.includeCachedNodes && materializedNodes.length === 0) {
    throw new MaterializationError('完整配置暂不可用：当前用户没有可用节点');
  }

  return {
    customNodes,
    providers,
    materializedNodes,
  };
}

export async function buildDefaultMaterializedArtifact(
  config: DesiredConfigDraft,
  env: Env
): Promise<MaterializedArtifact> {
  const data = await collectSubscriptionData(
    {
      id: 'usr_artifact_builder',
      name: 'artifact builder',
      enabled: true,
      createdAt: new Date(0).toISOString(),
    },
    env,
    { includeCachedNodes: true },
    config
  );
  const yaml = await buildFullConfig(
    data.materializedNodes,
    [],
    env,
    config.policy,
    data.customNodes.map((node) => node.name),
    true
  );
  const bytes = new TextEncoder().encode(yaml).byteLength;
  if (bytes > MAX_MATERIALIZED_ARTIFACT_BYTES) {
    throw new Error('物化产物超过 KV 安全大小限制');
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    yaml,
  };
}

export async function rebuildDefaultMaterializedArtifact(
  env: Env
): Promise<{ ok: boolean; revision: string; bytes?: number; error?: string }> {
  const current = await loadActiveDesiredConfig(env.KV);
  try {
    const artifact = await buildDefaultMaterializedArtifact(toDraft(current), env);
    const published = await publishDesiredConfig(env.KV, toDraft(current), {
      expectedRevision: current.revision,
      materializedArtifact: artifact,
      forceRevision: true,
      retainRevisionSnapshot: false,
    });
    return {
      ok: true,
      revision: published.config.revision,
      bytes: new TextEncoder().encode(artifact.yaml).byteLength,
    };
  } catch (error) {
    return {
      ok: false,
      revision: current.revision,
      error: error instanceof ConfigConflictError
        ? '配置已更新，请重试物化'
        : '物化产物生成失败',
    };
  }
}

async function opportunisticallyBundleArtifact(
  current: DesiredConfigV2,
  yaml: string,
  env: Env
): Promise<void> {
  const artifact: MaterializedArtifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    yaml,
  };
  try {
    await publishDesiredConfig(env.KV, toDraft(current), {
      expectedRevision: current.revision,
      materializedArtifact: artifact,
      forceRevision: true,
      retainRevisionSnapshot: false,
    });
  } catch {
    // Another administrator/refresh may have published first. The current
    // response is still complete; the next request will read the winning bundle.
  }
}

function materializedResponse(
  yaml: string,
  artifactStatus: 'hit' | 'miss'
): Response {
  return new Response(yaml, {
    headers: {
      ...subscriptionHeaders(
        'text/yaml; charset=utf-8',
        'clash_sub_hub_materialized.yaml'
      ),
      'X-Clash-Artifact': artifactStatus,
    },
  });
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
  return stringifyYaml(doc);
}

async function safeBuildFullConfig(
  proxies: ProxyNode[],
  providers: ProviderInfo[],
  env: Env,
  policy: MaterializedPolicy,
  customNodeNames: string[],
  materialized: boolean
): Promise<string | Response> {
  try {
    return await buildFullConfig(
      proxies,
      providers,
      env,
      policy,
      customNodeNames,
      materialized
    );
  } catch {
    console.error('完整配置生成失败');
    return new Response('完整配置生成失败', {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

async function buildFullConfig(
  proxies: ProxyNode[],
  providers: ProviderInfo[],
  env: Env,
  policy: MaterializedPolicy,
  customNodeNames: string[],
  materialized: boolean
): Promise<string> {
  void env;
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

  const result = runBuiltinScript(config);
  if (!result || typeof result !== 'object') {
    throw new Error('内置配置生成器返回了无效结果');
  }
  config = result;

  applySafePolicyOverrides(config, policy);
  injectAvailableNodes(config, materialized, customNodeNames);
  if (materialized) {
    delete config['proxy-providers'];
  }

  return stringifyYaml(config);
}

export function injectAvailableNodes(
  config: Record<string, unknown>,
  materialized: boolean,
  customNodeNames: string[] = []
): void {
  const allProxyNames = ((config.proxies as ProxyNode[]) || []).map((p) => p.name);
  const customNames = new Set(customNodeNames);
  const providerProxyNames = allProxyNames.filter((name) => !customNames.has(name));
  const groups = config['proxy-groups'] as Record<string, unknown>[] | undefined;
  if (!groups || !Array.isArray(groups) || allProxyNames.length === 0) return;

  for (const group of groups) {
    const isManualSelection = group.name === '节点选择';
    if (!('use' in group) && !isManualSelection) continue;
    const existing = (group.proxies as string[]) || [];
    const filter = isManualSelection ? undefined : group.filter as string | undefined;
    let namesToAdd = isManualSelection
      ? allProxyNames
      : (
        providerProxyNames.length > 0
          ? providerProxyNames
          : (materialized ? allProxyNames : [])
      );
    if (filter) {
      try {
        const re = new RegExp(filter);
        namesToAdd = namesToAdd.filter((n) => re.test(n));
      } catch { /* 无效正则，跳过过滤 */ }
    }
    group.proxies = [...new Set([...existing, ...namesToAdd])];
    if (materialized) {
      delete group.use;
      delete group.filter;
    }
  }
}

function applySafePolicyOverrides(
  config: Record<string, unknown>,
  policy: MaterializedPolicy
): void {
  const dns = config.dns as Record<string, unknown> | undefined;
  const nameserverPolicy = dns?.['nameserver-policy'] as
    Record<string, unknown> | undefined;
  if (dns && nameserverPolicy && policy.domesticNameservers) {
    const nameservers = [...policy.domesticNameservers];
    dns['proxy-server-nameserver'] = nameservers;
    nameserverPolicy['geosite:private,cn'] = nameservers;
    const academicKey = Object.keys(nameserverPolicy)
      .find((key) => key.includes('nature.com'));
    if (academicKey) nameserverPolicy[academicKey] = nameservers;
  }
  if (dns && nameserverPolicy && policy.foreignNameservers) {
    const nameservers = [...policy.foreignNameservers];
    dns.nameserver = nameservers;
    for (const key of Object.keys(nameserverPolicy)) {
      if (key.startsWith('geosite:') && key !== 'geosite:private,cn') {
        nameserverPolicy[key] = nameservers;
      }
      if (key.includes('claude.ai')) nameserverPolicy[key] = nameservers;
    }
  }
  if (dns && policy.dnsFakeIpFilterAppend) {
    const existing = Array.isArray(dns['fake-ip-filter'])
      ? dns['fake-ip-filter'] as string[]
      : [];
    dns['fake-ip-filter'] = [
      ...new Set([...existing, ...policy.dnsFakeIpFilterAppend]),
    ];
  }

  const tun = config.tun as Record<string, unknown> | undefined;
  if (tun && policy.tunRouteExcludeAddresses) {
    const existing = Array.isArray(tun['route-exclude-address'])
      ? tun['route-exclude-address'] as string[]
      : [];
    tun['route-exclude-address'] = [
      ...new Set([...existing, ...policy.tunRouteExcludeAddresses]),
    ];
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
