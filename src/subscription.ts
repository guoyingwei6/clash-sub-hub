import { Env, User, Upstream, ProxyNode } from './types';
import yaml from 'js-yaml';
import {
  parseClashYaml,
  filterNodes,
  deduplicateNodes,
  nodesToBase64,
} from './converter';

export async function handleSubscription(
  token: string,
  format: string | null,
  env: Env
): Promise<Response> {
  // 校验用户
  const usersRaw = await env.KV.get('users');
  if (!usersRaw) return new Response('未找到用户', { status: 403 });

  const users: User[] = JSON.parse(usersRaw);
  const user = users.find((u) => u.token === token);
  if (!user) return new Response('无效的订阅链接', { status: 403 });
  if (!user.enabled) return new Response('订阅已被禁用', { status: 403 });

  // 收集所有节点
  const allNodes = await collectAllNodes(env);

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

  // 默认格式：完整 Clash 配置
  const fullConfig = await buildFullConfig(allNodes, env);
  return new Response(fullConfig, {
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="config.yaml"',
      'Profile-Update-Interval': '1',
    },
  });
}

async function collectAllNodes(env: Env): Promise<ProxyNode[]> {
  const upstreamsRaw = await env.KV.get('upstreams');
  const upstreams: Upstream[] = upstreamsRaw ? JSON.parse(upstreamsRaw) : [];

  let allNodes: ProxyNode[] = [];

  const cacheResults = await Promise.all(
    upstreams.map((u) => env.KV.get(`cache:${u.name}`))
  );

  for (let i = 0; i < upstreams.length; i++) {
    const cache = cacheResults[i];
    if (cache) {
      const nodes = parseClashYaml(cache);
      const filtered = filterNodes(nodes);
      // 给每个上游节点加前缀，和 Clash Verge additional-prefix 效果一致
      const prefix = `${upstreams[i].name} | `;
      for (const n of filtered) {
        n.name = prefix + n.name;
      }
      allNodes.push(...filtered);
    }
  }

  // 追加自建节点（不过滤）
  const customRaw = await env.KV.get('custom-nodes');
  if (customRaw) {
    const customNodes: ProxyNode[] = JSON.parse(customRaw);
    allNodes.push(...customNodes);
  }

  return deduplicateNodes(allNodes);
}

async function buildFullConfig(
  proxies: ProxyNode[],
  env: Env
): Promise<string> {
  const script = await env.KV.get('script');

  // 构造一个基础 config 对象，模拟 Clash Verge 传给脚本的 config
  const baseConfig: Record<string, unknown> = {
    proxies,
    'proxy-groups': [],
    'proxy-providers': {},
    'rule-providers': {},
    rules: [],
  };

  if (script) {
    try {
      // 在沙箱中执行管理员脚本
      const result = executeScript(script, baseConfig);
      if (result) {
        return yaml.dump(result, { lineWidth: -1, noRefs: true });
      }
    } catch (e) {
      // 脚本执行失败，回退到纯节点输出
      console.error('脚本执行失败:', e);
    }
  }

  // 无脚本或脚本失败：输出基础配置
  return yaml.dump(baseConfig, { lineWidth: -1, noRefs: true });
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
