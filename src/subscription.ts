import { Env, User, Upstream, ProxyNode } from './types';
import yaml from 'js-yaml';
import {
  parseClashYaml,
  filterNodes,
  deduplicateNodes,
  nodesToBase64,
} from './converter';
import { getGlobalSettings } from './settings';

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

  // 收集该用户可见的节点
  const allNodes = await collectAllNodes(user, env);

  // base64 格式：直接输出 URI 列表
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

  // 默认/full 模式：完整 Clash 配置（节点 + 脚本规则）
  const fullConfig = await buildFullConfig(allNodes, env);
  return new Response(fullConfig, {
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="config.yaml"',
      'Profile-Update-Interval': '1',
    },
  });
}

async function collectAllNodes(user: User, env: Env): Promise<ProxyNode[]> {
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

  const cacheResults = await Promise.all(
    upstreams.map((u) => env.KV.get(`cache:${u.name}`))
  );

  for (let i = 0; i < upstreams.length; i++) {
    const cache = cacheResults[i];
    if (cache) {
      const nodes = parseClashYaml(cache);
      let filtered = shouldFilter ? filterNodes(nodes) : nodes;
      // 排除关键词
      if (upstreams[i].exclude) {
        try {
          const re = new RegExp(upstreams[i].exclude!, 'i');
          filtered = filtered.filter((n) => !re.test(n.name));
        } catch { /* 无效正则，跳过 */ }
      }
      // 前缀：undefined=用名称, ''=不加, 其他=自定义
      const prefix = upstreams[i].prefix === undefined ? `${upstreams[i].name} | ` : (upstreams[i].prefix ? `${upstreams[i].prefix} | ` : '');
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

  return deduplicateNodes(allNodes);
}

async function buildFullConfig(
  proxies: ProxyNode[],
  env: Env
): Promise<string> {
  const baseScript = await env.KV.get('script-base') || await env.KV.get('script') || '';
  const overrideScript = await env.KV.get('script-override') || '';

  let config: Record<string, unknown> = {
    proxies,
    'proxy-groups': [],
    'proxy-providers': {},
    'rule-providers': {},
    rules: [],
  };

  // 链式执行：基础脚本 → 自定义脚本
  if (baseScript) {
    try {
      const result = executeScript(baseScript, config);
      if (result) config = result;
    } catch (e) {
      console.error('基础脚本执行失败:', e);
    }
  }

  if (overrideScript) {
    try {
      const result = executeScript(overrideScript, config);
      if (result) config = result;
    } catch (e) {
      console.error('自定义脚本执行失败:', e);
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
