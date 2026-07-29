import { ProxyNode } from '../types';
import { parseYaml, stringifyYaml } from '../yaml';
import {
  DEFAULT_MATERIALIZED_POLICY,
  DESIRED_CONFIG_SCHEMA_VERSION,
  DesiredConfigDraft,
  MaterializedPolicy,
  UpstreamDefinition,
  UpstreamFetchMode,
} from './config';
import { isReservedProxyName } from './reserved-names';

type NamedEntity = { name: string };

export interface UpdatedEntity {
  name: string;
  changedFields: string[];
}

export interface EntityDiff {
  added: string[];
  updated: UpdatedEntity[];
  deleted: string[];
  unchanged: string[];
}

export interface MergeDiff {
  upstreams: EntityDiff;
  customNodes: EntityDiff;
  policyChangedFields: string[];
  hasChanges: boolean;
}

export class MergeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeValidationError';
  }
}

export function parseMergeYaml(
  text: string,
  current?: DesiredConfigDraft
): DesiredConfigDraft {
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error) {
    const line = yamlErrorLine(error);
    throw new MergeValidationError(`YAML 解析失败${line ? `（第 ${line} 行）` : ''}`);
  }

  if (!isRecord(value)) {
    throw new MergeValidationError('Merge 顶层必须是 YAML 对象');
  }

  const currentIds = new Map(current?.upstreams.map((item) => [item.name, item.id]) ?? []);
  const upstreams = parseProviders(value['proxy-providers'], currentIds);
  const customNodes = parseCustomNodes(value.proxies);
  const policy = parsePolicy(value['x-clash-sub-hub'], current?.policy);

  return {
    schemaVersion: DESIRED_CONFIG_SCHEMA_VERSION,
    upstreams,
    customNodes,
    policy,
  };
}

export function diffDesiredConfig(
  current: DesiredConfigDraft,
  desired: DesiredConfigDraft
): MergeDiff {
  const upstreams = diffEntities(
    current.upstreams,
    desired.upstreams,
    ['url', 'userAgent', 'prefix', 'exclude', 'fetchMode', 'required', 'providerOptions']
  );
  const customNodes = diffEntities(current.customNodes, desired.customNodes);
  const policyChangedFields = changedObjectFields(current.policy, desired.policy);
  return {
    upstreams,
    customNodes,
    policyChangedFields,
    hasChanges:
      upstreams.added.length > 0 ||
      upstreams.updated.length > 0 ||
      upstreams.deleted.length > 0 ||
      customNodes.added.length > 0 ||
      customNodes.updated.length > 0 ||
      customNodes.deleted.length > 0 ||
      policyChangedFields.length > 0,
  };
}

export function serializeMergeConfig(config: DesiredConfigDraft): string {
  const providers: Record<string, unknown> = {};
  for (const upstream of config.upstreams) {
    const provider: Record<string, unknown> = {
      ...upstream.providerOptions,
      type: 'http',
      url: upstream.url,
      header: { 'User-Agent': [upstream.userAgent, 'Mihomo'] },
    };
    if (upstream.prefix) {
      provider.override = { 'additional-prefix': upstream.prefix };
    }
    if (upstream.exclude) {
      provider['exclude-filter'] = upstream.exclude;
    }
    if (upstream.fetchMode !== 'server') {
      provider['x-clash-sub-hub-fetch-mode'] = upstream.fetchMode;
    }
    provider['x-clash-sub-hub-id'] = upstream.id;
    provider['x-clash-sub-hub-required'] = upstream.required;
    providers[upstream.name] = provider;
  }

  const document: Record<string, unknown> = {};
  if (Object.keys(providers).length > 0) document['proxy-providers'] = providers;
  if (config.customNodes.length > 0) document.proxies = config.customNodes;
  document['x-clash-sub-hub'] = {
    'schema-version': DESIRED_CONFIG_SCHEMA_VERSION,
    policy: {
      'filter-upstream-info-nodes': config.policy.filterUpstreamInfoNodes,
      'missing-cache': config.policy.missingCache,
      'max-cache-age-seconds': config.policy.maxCacheAgeSeconds,
      ...(config.policy.domesticNameservers
        ? { 'domestic-nameservers': config.policy.domesticNameservers }
        : {}),
      ...(config.policy.foreignNameservers
        ? { 'foreign-nameservers': config.policy.foreignNameservers }
        : {}),
      ...(config.policy.tunRouteExcludeAddresses
        ? { 'tun-route-exclude-addresses': config.policy.tunRouteExcludeAddresses }
        : {}),
      ...(config.policy.dnsFakeIpFilterAppend
        ? { 'dns-fake-ip-filter-append': config.policy.dnsFakeIpFilterAppend }
        : {}),
    },
  };

  return stringifyYaml(document);
}

function parseProviders(
  value: unknown,
  currentIds: Map<string, string>
): UpstreamDefinition[] {
  if (value === undefined || value === null) return [];
  if (!isRecord(value)) {
    throw new MergeValidationError('proxy-providers 必须是对象');
  }

  const parsed = Object.entries(value).map(([name, rawProvider]) => {
    if (!name.trim()) throw new MergeValidationError('上游名称不能为空');
    if (!isRecord(rawProvider)) {
      throw new MergeValidationError(`上游 ${name} 必须是对象`);
    }

    const type = rawProvider.type ?? 'http';
    if (type !== 'http') {
      throw new MergeValidationError(`上游 ${name} 仅支持 type: http`);
    }

    const url = requireString(rawProvider.url, `上游 ${name} 缺少 url`);
    validateHttpUrl(url, name);
    const userAgent = parseUserAgent(rawProvider.header);
    const prefix = parsePrefix(rawProvider.override, name);
    const exclude = optionalString(rawProvider['exclude-filter'], `上游 ${name} 的 exclude-filter`);
    const fetchMode = parseFetchMode(rawProvider['x-clash-sub-hub-fetch-mode'], name);
    const required = parseRequired(rawProvider['x-clash-sub-hub-required'], name);
    const explicitId = parseUpstreamId(rawProvider['x-clash-sub-hub-id'], name);
    const currentId = currentIds.get(name);
    if (explicitId && currentId && explicitId !== currentId) {
      throw new MergeValidationError(`上游 ${name} 的 id 与当前配置不一致`);
    }

    const providerOptions = { ...rawProvider };
    delete providerOptions.url;
    delete providerOptions.header;
    delete providerOptions.override;
    delete providerOptions['exclude-filter'];
    delete providerOptions['x-clash-sub-hub-fetch-mode'];
    delete providerOptions['x-clash-sub-hub-id'];
    delete providerOptions['x-clash-sub-hub-required'];

    return {
      // A deterministic fallback keeps preview, mirror preloading and apply on
      // the same identity even though they parse the Merge in separate requests.
      id: currentId ?? explicitId ?? upstreamIdForName(name),
      name,
      url,
      userAgent,
      prefix,
      exclude,
      fetchMode,
      required,
      providerOptions,
    };
  });

  const seenIds = new Set<string>();
  for (const upstream of parsed) {
    if (seenIds.has(upstream.id)) {
      throw new MergeValidationError(`上游 id 重复: ${upstream.id}`);
    }
    seenIds.add(upstream.id);
  }
  return parsed;
}

function parseCustomNodes(value: unknown): ProxyNode[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new MergeValidationError('proxies 必须是数组');
  }

  const seen = new Set<string>();
  return value.map((rawNode, index) => {
    if (!isRecord(rawNode)) {
      throw new MergeValidationError(`proxies[${index}] 必须是对象`);
    }

    const name = requireString(rawNode.name, `proxies[${index}] 缺少 name`);
    if (isReservedProxyName(name)) {
      throw new MergeValidationError(`自建节点名称与内置分组冲突: ${name}`);
    }
    if (seen.has(name)) {
      throw new MergeValidationError(`自建节点名称重复: ${name}`);
    }
    seen.add(name);

    requireString(rawNode.type, `自建节点 ${name} 缺少 type`);
    requireString(rawNode.server, `自建节点 ${name} 缺少 server`);
    const port = Number(rawNode.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new MergeValidationError(`自建节点 ${name} 的 port 无效`);
    }

    return { ...rawNode, name, port } as ProxyNode;
  });
}

function parsePolicy(
  value: unknown,
  current?: MaterializedPolicy
): MaterializedPolicy {
  const fallback = current ?? DEFAULT_MATERIALIZED_POLICY;
  if (value === undefined || value === null) return { ...fallback };
  if (!isRecord(value)) {
    throw new MergeValidationError('x-clash-sub-hub 必须是对象');
  }
  const rawPolicy = value.policy;
  if (rawPolicy === undefined || rawPolicy === null) return { ...fallback };
  if (!isRecord(rawPolicy)) {
    throw new MergeValidationError('x-clash-sub-hub.policy 必须是对象');
  }

  const filterValue = rawPolicy['filter-upstream-info-nodes'];
  const filterUpstreamInfoNodes = filterValue === undefined
    ? fallback.filterUpstreamInfoNodes
    : requireBoolean(filterValue, 'filter-upstream-info-nodes');
  const missingValue = rawPolicy['missing-cache'];
  const missingCache = missingValue === undefined
    ? fallback.missingCache
    : parseMissingCache(missingValue);
  const ageValue = rawPolicy['max-cache-age-seconds'];
  const maxCacheAgeSeconds = ageValue === undefined
    ? fallback.maxCacheAgeSeconds
    : requireCacheAge(ageValue);
  const domesticNameservers = parseOptionalUrlList(
    rawPolicy['domestic-nameservers'],
    fallback.domesticNameservers,
    'domestic-nameservers'
  );
  const foreignNameservers = parseOptionalUrlList(
    rawPolicy['foreign-nameservers'],
    fallback.foreignNameservers,
    'foreign-nameservers'
  );
  const tunRouteExcludeAddresses = parseOptionalCidrList(
    rawPolicy['tun-route-exclude-addresses'],
    fallback.tunRouteExcludeAddresses
  );
  const dnsFakeIpFilterAppend = parseOptionalDomainPatternList(
    rawPolicy['dns-fake-ip-filter-append'],
    fallback.dnsFakeIpFilterAppend
  );

  return {
    filterUpstreamInfoNodes,
    missingCache,
    maxCacheAgeSeconds,
    ...(domesticNameservers ? { domesticNameservers } : {}),
    ...(foreignNameservers ? { foreignNameservers } : {}),
    ...(tunRouteExcludeAddresses ? { tunRouteExcludeAddresses } : {}),
    ...(dnsFakeIpFilterAppend ? { dnsFakeIpFilterAppend } : {}),
  };
}

function diffEntities<T extends NamedEntity>(
  currentItems: T[],
  desiredItems: T[],
  fields?: string[]
): EntityDiff {
  const current = new Map(currentItems.map((item) => [item.name, item]));
  const desired = new Map(desiredItems.map((item) => [item.name, item]));
  const added: string[] = [];
  const updated: UpdatedEntity[] = [];
  const deleted: string[] = [];
  const unchanged: string[] = [];

  for (const [name, item] of desired) {
    const before = current.get(name);
    if (!before) {
      added.push(name);
      continue;
    }
    const changedFields = changedEntityFields(before, item, fields);
    if (changedFields.length > 0) updated.push({ name, changedFields });
    else unchanged.push(name);
  }

  for (const name of current.keys()) {
    if (!desired.has(name)) deleted.push(name);
  }

  added.sort();
  deleted.sort();
  unchanged.sort();
  updated.sort((a, b) => a.name.localeCompare(b.name));
  return { added, updated, deleted, unchanged };
}

function changedEntityFields<T extends NamedEntity>(
  before: T,
  after: T,
  fields?: string[]
): string[] {
  const keys = fields ?? [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => key !== 'name');
  return keys
    .filter((key) => stableValue(before[key as keyof T]) !== stableValue(after[key as keyof T]))
    .sort();
}

function changedObjectFields(
  before: object,
  after: object
): string[] {
  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  return [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])]
    .filter((key) => stableValue(beforeRecord[key]) !== stableValue(afterRecord[key]))
    .sort();
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseUserAgent(header: unknown): string {
  if (!isRecord(header) || header['User-Agent'] === undefined) return 'clash.meta';
  const value = header['User-Agent'];
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string' && item.trim());
    return first?.trim() || 'clash.meta';
  }
  return String(value).trim() || 'clash.meta';
}

function parsePrefix(override: unknown, name: string): string {
  if (!isRecord(override) || override['additional-prefix'] === undefined) {
    return `${name} | `;
  }
  const value = override['additional-prefix'];
  if (typeof value !== 'string') {
    throw new MergeValidationError(`上游 ${name} 的 additional-prefix 必须是字符串`);
  }
  return value;
}

function parseFetchMode(value: unknown, name: string): UpstreamFetchMode {
  if (value === undefined) return 'server';
  if (value === 'server' || value === 'mirror' || value === 'disabled') return value;
  throw new MergeValidationError(`上游 ${name} 的 fetch mode 无效`);
}

function parseRequired(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  throw new MergeValidationError(`上游 ${name} 的 required 必须是布尔值`);
}

function parseUpstreamId(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^up_[a-f0-9]{32}$/i.test(value)) {
    throw new MergeValidationError(`上游 ${name} 的 id 无效`);
  }
  return value.toLowerCase();
}

function parseMissingCache(value: unknown): MaterializedPolicy['missingCache'] {
  if (value === 'fail' || value === 'serve-stale') return value;
  throw new MergeValidationError('missing-cache 仅支持 fail 或 serve-stale');
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new MergeValidationError(`${label} 必须是布尔值`);
  }
  return value;
}

function requireCacheAge(value: unknown): number {
  const age = Number(value);
  if (!Number.isInteger(age) || age < 60 || age > 7 * 24 * 60 * 60) {
    throw new MergeValidationError('max-cache-age-seconds 必须是 60 到 604800 的整数');
  }
  return age;
}

function parseOptionalUrlList(
  value: unknown,
  fallback: string[] | undefined,
  label: string
): string[] | undefined {
  if (value === undefined) return fallback ? [...fallback] : undefined;
  const items = requireStringList(value, label, 16);
  if (items.length === 0) {
    throw new MergeValidationError(`${label} 不能为空数组`);
  }
  for (const item of items) {
    let parsed: URL;
    try {
      parsed = new URL(item);
    } catch {
      throw new MergeValidationError(`${label} 包含无效 URL`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new MergeValidationError(`${label} 仅支持 http/https URL`);
    }
  }
  return items;
}

function parseOptionalCidrList(
  value: unknown,
  fallback: string[] | undefined
): string[] | undefined {
  if (value === undefined) return fallback ? [...fallback] : undefined;
  const items = requireStringList(value, 'tun-route-exclude-addresses', 32);
  for (const item of items) {
    if (!isIpOrCidr(item)) {
      throw new MergeValidationError('tun-route-exclude-addresses 包含无效 IP/CIDR');
    }
  }
  return items;
}

function parseOptionalDomainPatternList(
  value: unknown,
  fallback: string[] | undefined
): string[] | undefined {
  if (value === undefined) return fallback ? [...fallback] : undefined;
  const items = requireStringList(value, 'dns-fake-ip-filter-append', 64);
  for (const item of items) {
    if (
      item.length > 253
      || !/^(?:\+\.|\*\.)?[A-Za-z0-9_*.-]+$/.test(item)
      || item.includes('..')
    ) {
      throw new MergeValidationError('dns-fake-ip-filter-append 包含无效域名模式');
    }
  }
  return items;
}

function requireStringList(
  value: unknown,
  label: string,
  maxItems: number
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new MergeValidationError(`${label} 必须是最多 ${maxItems} 项的字符串数组`);
  }
  const items = value.map((item) => {
    if (
      typeof item !== 'string'
      || !item.trim()
      || item.length > 2048
      || /[\r\n\0]/.test(item)
    ) {
      throw new MergeValidationError(`${label} 包含无效字符串`);
    }
    return item.trim();
  });
  return [...new Set(items)];
}

function isIpOrCidr(value: string): boolean {
  const [address, prefix, extra] = value.split('/');
  if (extra !== undefined || !address) return false;
  if (address.includes(':')) {
    if (!/^[0-9A-Fa-f:]+$/.test(address) || !address.includes(':')) return false;
    if (prefix === undefined) return true;
    const bits = Number(prefix);
    return Number.isInteger(bits) && bits >= 0 && bits <= 128;
  }
  const octets = address.split('.');
  if (
    octets.length !== 4
    || octets.some((octet) =>
      !/^\d{1,3}$/.test(octet) || Number(octet) > 255
    )
  ) {
    return false;
  }
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  return Number.isInteger(bits) && bits >= 0 && bits <= 32;
}

export function upstreamIdForName(name: string): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const hashes = seeds.map((seed) => {
    let hash = seed;
    for (const char of name) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 0x01000193);
      hash ^= hash >>> 13;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  });
  return `up_${hashes.join('')}`;
}

export function newUpstreamId(): string {
  return `up_${crypto.randomUUID().replaceAll('-', '')}`;
}

function validateHttpUrl(value: string, name: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MergeValidationError(`上游 ${name} 的 url 无效`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new MergeValidationError(`上游 ${name} 的 url 仅支持 http/https`);
  }
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new MergeValidationError(message);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new MergeValidationError(`${label} 必须是字符串`);
  return value;
}

function yamlErrorLine(error: unknown): number | null {
  if (!isRecord(error)) return null;
  if (Array.isArray(error.linePos) && isRecord(error.linePos[0])) {
    return typeof error.linePos[0].line === 'number' ? error.linePos[0].line : null;
  }
  if (isRecord(error.mark) && typeof error.mark.line === 'number') {
    return error.mark.line + 1;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
