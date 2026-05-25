import { Env, User, Upstream, ProxyNode } from './types';
import yaml from 'js-yaml';
import {
  parseClashYaml,
  filterNodes,
  deduplicateNodes,
  nodesToBase64,
} from './converter';
import { getGlobalSettings } from './settings';
import { main as builtinScript } from '../ClashVerge-AI-Academic-Enhanced.js';

export async function handleSubscription(
  token: string,
  format: string | null,
  mode: string | null,
  env: Env
): Promise<Response> {
  // 校验用户
  const usersRaw = await env.KV.get('users');
  if (!usersRaw) return new Response('未找到用户', { status: 403 });

  const users: User[] = JSON.parse(usersRaw);
  const user = users.find((u) => u.token === token);
  if (!user) return new Response('无效的订阅链接', { status: 403 });
  if (!user.enabled) return new Response('订阅已被禁用', { status: 403 });

  // 收集该用户可见的节点 + 本地拉取的上游
  const { nodes: allNodes, providers } = await collectAllNodes(user, env);

  // base64 格式：直接输出 URI 列表（本地拉取的上游无法包含）
  if (format === 'base64') {
    return new Response(nodesToBase64(allNodes), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="proxies"',
        'Profile-Update-Interval': '1',
      },
    });
  }

  // 纯节点模式：只输出 proxies，不跑脚本、不加规则
  if (mode === 'nodes') {
    const nodesConfig = yaml.dump({ proxies: allNodes }, { lineWidth: -1, noRefs: true });
    return new Response(nodesConfig, {
      headers: {
        'Content-Type': 'text/yaml; charset=utf-8',
        'Content-Disposition': 'attachment; filename="nodes.yaml"',
        'Profile-Update-Interval': '1',
      },
    });
  }

  // 默认/full 模式：完整 Clash 配置（节点 + 脚本规则 + proxy-providers）
  const fullConfig = await buildFullConfig(allNodes, providers, env);
  return new Response(fullConfig, {
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="config.yaml"',
      'Profile-Update-Interval': '1',
    },
  });
}

interface ProviderInfo {
  name: string;
  url: string;
  userAgent: string;
  prefix: string;
  exclude?: string;
}

async function collectAllNodes(user: User, env: Env): Promise<{ nodes: ProxyNode[]; providers: ProviderInfo[] }> {
  const upstreamsRaw = await env.KV.get('upstreams');
  let upstreams: Upstream[] = upstreamsRaw ? JSON.parse(upstreamsRaw) : [];

  // 判断是否过滤：用户设置优先，否则跟随全局
  const settings = await getGlobalSettings(env);
  const shouldFilter = user.filterNodes != null ? user.filterNodes : settings.filterEnabled;

  // 按用户权限过滤上游
  if (user.allowedUpstreams != null) {
    upstreams = upstreams.filter((u) => user.allowedUpstreams!.includes(u.name));
  }

  let allNodes: ProxyNode[] = [];
  const providers: ProviderInfo[] = [];

  // 分离：本地拉取的上游 vs CF拉取的上游
  const cfUpstreams = upstreams.filter((u) => !u.localFetch);
  const localUpstreams = upstreams.filter((u) => u.localFetch);

  // 本地拉取的上游 → 输出为 proxy-providers
  for (const u of localUpstreams) {
    const prefix = u.prefix === undefined ? `${u.name} | ` : (u.prefix ? `${u.prefix} | ` : '');
    providers.push({
      name: u.name,
      url: u.url,
      userAgent: u.userAgent || settings.defaultUA,
      prefix,
      exclude: u.exclude,
    });
  }

  // CF拉取的上游 → 直接读缓存
  const cacheResults = await Promise.all(
    cfUpstreams.map((u) => env.KV.get(`cache:${u.name}`))
  );

  for (let i = 0; i < cfUpstreams.length; i++) {
    const cache = cacheResults[i];
    if (cache) {
      const nodes = parseClashYaml(cache);
      let filtered = shouldFilter ? filterNodes(nodes) : nodes;
      if (cfUpstreams[i].exclude) {
        try {
          const re = new RegExp(cfUpstreams[i].exclude!, 'i');
          filtered = filtered.filter((n) => !re.test(n.name));
        } catch { /* 无效正则，跳过 */ }
      }
      const prefix = cfUpstreams[i].prefix === undefined ? `${cfUpstreams[i].name} | ` : (cfUpstreams[i].prefix ? `${cfUpstreams[i].prefix} | ` : '');
      if (prefix) {
        for (const n of filtered) {
          n.name = prefix + n.name;
        }
      }
      allNodes.push(...filtered);
    }
  }

  // 追加自建节点（按用户权限过滤）
  const customRaw = await env.KV.get('custom-nodes');
  if (customRaw) {
    let customNodes: ProxyNode[] = JSON.parse(customRaw);
    if (user.allowedCustomNodes != null) {
      customNodes = customNodes.filter((n) => user.allowedCustomNodes!.includes(n.name));
    }
    allNodes.push(...customNodes);
  }

  return { nodes: deduplicateNodes(allNodes), providers };
}

async function buildFullConfig(
  proxies: ProxyNode[],
  providers: ProviderInfo[],
  env: Env
): Promise<string> {
  const overrideScript = await env.KV.get('script-override') || '';

  // 构建 proxy-providers（本地拉取的上游）
  const proxyProviders: Record<string, unknown> = {};
  for (const p of providers) {
    const provider: Record<string, unknown> = {
      type: 'http',
      url: p.url,
      interval: 3600,
      path: `./providers/${p.name}.yaml`,
      'health-check': {
        enable: true,
        url: 'http://www.gstatic.com/generate_204',
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

  // 执行内置脚本（静态导入，不需要 new Function）
  try {
    const result = builtinScript(config);
    if (result && typeof result === 'object') config = result;
  } catch (e) {
    console.error('内置脚本执行失败:', e);
  }

  // 执行自定义追加脚本（需要 new Function，免费版可能不可用）
  if (overrideScript) {
    try {
      const result = executeScript(overrideScript, config);
      if (result) config = result;
    } catch (e) {
      console.error('自定义脚本执行失败:', e);
    }
  }

  // 脚本执行后，把 proxies 里的节点名注入到带 use 的分组
  // （脚本设计给 Clash Verge 本地用，依赖 proxy-providers 获取机场节点；
  //   Hub 把节点直接放在 proxies 里，需要补充到分组的 proxies 字段）
  const allProxyNames = (config.proxies as ProxyNode[]).map((p) => p.name);
  const groups = config['proxy-groups'] as Record<string, unknown>[] | undefined;
  if (groups && Array.isArray(groups) && allProxyNames.length > 0) {
    for (const group of groups) {
      if (!group.use) continue; // 只处理引用了 proxy-providers 的分组
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

  return yaml.dump(config, { lineWidth: -1, noRefs: true });
}

function executeScript(
  scriptText: string,
  config: Record<string, unknown>
): Record<string, unknown> | null {
  // 用 Function 构造器创建沙箱执行环境
  // 管理员脚本格式: function main(config) { ... return config; }
  // 我们提取 main 函数并执行
  const fn = new Function(
    'config',
    `${scriptText};\nif (typeof main === 'function') return main(config); return config;`
  );
  const result = fn(config);
  return result && typeof result === 'object' ? result : null;
}
