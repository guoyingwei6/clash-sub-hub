import { parseYaml } from '../yaml';

export type RoutingProfile = Record<string, unknown> & {
  rules: string[];
  'proxy-groups': Record<string, unknown>[];
  'rule-providers': Record<string, unknown>;
  dns: Record<string, unknown>;
};

// Deliberately excludes credentials, listeners and machine-local controller paths.
export const ROUTING_KEYS = [
  'rules', 'proxy-groups', 'rule-providers', 'dns', 'hosts', 'sniffer', 'tun',
  'mode', 'ipv6', 'unified-delay', 'geodata-loader', 'tcp-concurrent',
  'profile', 'tcp-fast-open', 'geosite-matcher', 'find-process-mode', 'log-level',
  'geodata-mode', 'geox-url', 'geo-auto-update', 'geo-update-interval',
] as const;

export class RoutingValidationError extends Error {}

export function parseRoutingYaml(text: string): RoutingProfile {
  let value: unknown;
  try { value = parseYaml(text); } catch {
    throw new RoutingValidationError('策略 YAML 解析失败');
  }
  return validateRoutingProfile(value);
}

export function validateRoutingProfile(value: unknown): RoutingProfile {
  if (!record(value)) throw new RoutingValidationError('策略必须是 YAML 对象');
  for (const key of Object.keys(value)) {
    if (!(ROUTING_KEYS as readonly string[]).includes(key)) {
      throw new RoutingValidationError(`策略不允许顶层字段: ${key}`);
    }
  }
  if (!Array.isArray(value.rules) || !value.rules.length
    || value.rules.some(rule => typeof rule !== 'string' || !rule.trim())) {
    throw new RoutingValidationError('rules 必须是非空规则字符串数组');
  }
  if (!Array.isArray(value['proxy-groups']) || !value['proxy-groups'].length) {
    throw new RoutingValidationError('proxy-groups 必须是非空数组');
  }
  if (!record(value.dns) || !record(value['rule-providers'])) {
    throw new RoutingValidationError('dns 和 rule-providers 必须是对象');
  }
  for (const key of ['hosts', 'sniffer', 'tun', 'profile']) {
    if (value[key] !== undefined && !record(value[key])) {
      throw new RoutingValidationError(`${key} 必须是对象`);
    }
  }
  for (const key of ['ipv6', 'unified-delay', 'tcp-concurrent', 'tcp-fast-open', 'geodata-mode', 'geo-auto-update']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new RoutingValidationError(`${key} 必须是布尔值`);
    }
  }
  for (const key of ['enable', 'ipv6', 'prefer-h3', 'respect-rules', 'use-system-hosts']) {
    if (value.dns[key] !== undefined && typeof value.dns[key] !== 'boolean') {
      throw new RoutingValidationError(`dns.${key} 必须是布尔值`);
    }
  }
  for (const key of ['nameserver', 'default-nameserver', 'proxy-server-nameserver', 'fallback', 'fake-ip-filter']) {
    if (value.dns[key] !== undefined) stringList(value.dns[key], `dns.${key}`);
  }
  if (value.dns['nameserver-policy'] !== undefined) {
    if (!record(value.dns['nameserver-policy'])) throw new RoutingValidationError('nameserver-policy 必须是对象');
    for (const servers of Object.values(value.dns['nameserver-policy'])) {
      if (typeof servers !== 'string') stringList(servers, 'nameserver-policy');
    }
  }
  const names = new Set<string>();
  for (const group of value['proxy-groups']) {
    if (!record(group) || typeof group.name !== 'string' || !group.name
      || typeof group.type !== 'string' || names.has(group.name)) {
      throw new RoutingValidationError('策略分组缺少名称、类型或名称重复');
    }
    names.add(group.name);
    if (!['select', 'url-test', 'fallback', 'load-balance', 'relay'].includes(group.type as string)) {
      throw new RoutingValidationError('不支持的分组类型');
    }
    if (typeof group.filter === 'string') {
      try { new RegExp(group.filter); } catch { throw new RoutingValidationError('分组 filter 正则无效'); }
    }
    for (const key of ['use', 'proxies']) {
      if (group[key] !== undefined && (!Array.isArray(group[key])
        || (group[key] as unknown[]).some(v => typeof v !== 'string'))) {
        throw new RoutingValidationError(`分组 ${key} 必须是字符串数组`);
      }
    }
  }
  // Prevent local filesystem references from reaching another device.
  for (const provider of Object.values(value['rule-providers'])) {
    if (!record(provider)) throw new RoutingValidationError('规则集必须是对象');
    if (provider.type === 'file') throw new RoutingValidationError('策略不能引用本地 file 规则集');
    if (provider.type === 'http') {
      try {
        const url = new URL(String(provider.url));
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch { throw new RoutingValidationError('规则集 URL 无效'); }
    }
    const p = provider.path;
    if (typeof p === 'string' && (p.startsWith('/') || p.split('/').includes('..'))) {
      throw new RoutingValidationError('规则集路径必须位于客户端配置目录内');
    }
  }
  return structuredClone(value) as RoutingProfile;
}

export function validateRoutingReferences(
  routing: RoutingProfile,
  providers: Record<string, unknown>,
  nodes: { name: string; [key: string]: unknown }[]
): void {
  const names = new Set([
    'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE',
    ...routing['proxy-groups'].map(g => String(g.name)),
    ...nodes.map(n => n.name),
  ]);
  for (const group of routing['proxy-groups']) {
    for (const name of (group.use ?? []) as string[]) {
      if (!Object.hasOwn(providers, name)) throw new RoutingValidationError(`分组引用的上游不可用: ${name}`);
    }
    for (const name of (group.proxies ?? []) as string[]) {
      if (!names.has(name)) throw new RoutingValidationError(`分组引用的节点不存在: ${name}`);
    }
  }
  for (const node of nodes) {
    if (typeof node['dialer-proxy'] === 'string' && !names.has(node['dialer-proxy'])) {
      throw new RoutingValidationError('节点的链式代理引用不存在');
    }
  }
  for (const rule of routing.rules) {
    const parts = rule.split(',');
    const target = parts.at(-1) === 'no-resolve' ? parts.at(-2) : parts.at(-1);
    if (!target || !names.has(target)) throw new RoutingValidationError('规则引用的目标不存在');
    if (parts[0] === 'RULE-SET' && !Object.hasOwn(routing['rule-providers'], parts[1])) {
      throw new RoutingValidationError('规则引用的规则集不存在');
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v)) {
    throw new RoutingValidationError(`${label} 必须是字符串数组`);
  }
}
