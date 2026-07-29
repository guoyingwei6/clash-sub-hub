import { ProxyNode, Upstream } from '../types';
import {
  DEFAULT_MATERIALIZED_POLICY,
  DESIRED_CONFIG_SCHEMA_VERSION,
  DesiredConfigDraft,
  DesiredConfigV2,
  MaterializedArtifact,
  UpstreamDefinition,
  createDesiredConfig,
} from '../domain/config';
import { diffDesiredConfig, upstreamIdForName } from '../domain/merge';

export const ACTIVE_CONFIG_KEY = 'config:v2:active';
export const CONFIG_REVISION_PREFIX = 'config:v2:revision:';
export const LEGACY_CONFIG_REVISION = 'legacy';
export const CONFIG_REVISION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_ACTIVE_CONFIG_BYTES = 24 * 1024 * 1024;

export interface TextKv {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PublishOptions {
  expectedRevision: string;
  now?: () => Date;
  revisionFactory?: () => string;
  materializedArtifact?: MaterializedArtifact;
  forceRevision?: boolean;
  retainRevisionSnapshot?: boolean;
}

export interface PublishResult {
  config: DesiredConfigV2;
  changed: boolean;
}

export class ConfigConflictError extends Error {
  readonly currentRevision: string;

  constructor(currentRevision: string) {
    super('配置已被其他操作更新，请重新预览');
    this.name = 'ConfigConflictError';
    this.currentRevision = currentRevision;
  }
}

export class ConfigStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigStateError';
  }
}

export async function loadActiveDesiredConfig(kv: TextKv): Promise<DesiredConfigV2> {
  const active = await kv.get(ACTIVE_CONFIG_KEY);
  if (!active) return loadLegacyDesiredConfig(kv);

  // V2 stores the complete active document in one KV value. This prevents a
  // reader in another POP from observing a new pointer before its revision
  // document has propagated. Plain strings remain readable for the old
  // pointer-based layout during migration.
  if (active.trimStart().startsWith('{')) {
    return parseDesiredConfig(active, '活动配置');
  }

  const raw = await kv.get(configRevisionKey(active));
  if (!raw) {
    throw new ConfigStateError(`活动配置修订 ${active} 不存在`);
  }
  const config = parseDesiredConfig(raw, `活动配置修订 ${active}`);
  if (config.revision !== active) {
    throw new ConfigStateError(`活动配置修订 ${active} 结构无效`);
  }
  return config;
}

export async function publishDesiredConfig(
  kv: TextKv,
  draft: DesiredConfigDraft,
  options: PublishOptions
): Promise<PublishResult> {
  const current = await loadActiveDesiredConfig(kv);
  if (current.revision !== options.expectedRevision) {
    throw new ConfigConflictError(current.revision);
  }

  if (
    !options.forceRevision
    && !diffDesiredConfig(toDraft(current), draft).hasChanges
  ) {
    return { config: current, changed: false };
  }

  const revisionFactory = options.revisionFactory ?? defaultRevision;
  const revision = revisionFactory();
  if (!revision || revision === LEGACY_CONFIG_REVISION) {
    throw new ConfigStateError('新配置 revision 无效');
  }
  const now = options.now ?? (() => new Date());
  const next = createDesiredConfig(
    draft,
    revision,
    now().toISOString(),
    options.materializedArtifact
  );
  const serialized = JSON.stringify(next);
  if (new TextEncoder().encode(serialized).byteLength > MAX_ACTIVE_CONFIG_BYTES) {
    throw new ConfigStateError('活动配置与物化产物超过 KV 大小限制');
  }

  // Configuration changes keep a bounded rollback snapshot. Artifact-only
  // refreshes explicitly skip this write: an hourly Cron must not retain a
  // second full copy of all node credentials on every run.
  if (options.retainRevisionSnapshot !== false) {
    await kv.put(
      configRevisionKey(revision),
      serialized,
      { expirationTtl: CONFIG_REVISION_TTL_SECONDS }
    );
  }

  const latest = await loadActiveDesiredConfig(kv);
  if (latest.revision !== options.expectedRevision) {
    throw new ConfigConflictError(latest.revision);
  }

  await kv.put(ACTIVE_CONFIG_KEY, serialized);
  return { config: next, changed: true };
}

export function toDraft(config: DesiredConfigV2): DesiredConfigDraft {
  return {
    schemaVersion: config.schemaVersion,
    upstreams: config.upstreams,
    customNodes: config.customNodes,
    policy: config.policy,
  };
}

export function configRevisionKey(revision: string): string {
  return `${CONFIG_REVISION_PREFIX}${revision}`;
}

async function loadLegacyDesiredConfig(kv: TextKv): Promise<DesiredConfigV2> {
  const upstreamRaw = await kv.get('upstreams');
  const nodeRaw = await kv.get('custom-nodes');
  const legacyUpstreams = parseJsonArray<Upstream>(upstreamRaw, 'upstreams');
  const customNodes = parseJsonArray<ProxyNode>(nodeRaw, 'custom-nodes');

  const upstreams: UpstreamDefinition[] = legacyUpstreams.map((upstream) => ({
    id: upstreamIdForName(upstream.name),
    name: upstream.name,
    url: upstream.url,
    userAgent: upstream.userAgent || 'clash.meta',
    prefix: legacyPrefix(upstream),
    exclude: upstream.exclude,
    fetchMode: upstream.localFetch ? 'mirror' : 'server',
    required: false,
    providerOptions: { type: 'http', interval: 3600 },
  }));

  return {
    schemaVersion: DESIRED_CONFIG_SCHEMA_VERSION,
    revision: LEGACY_CONFIG_REVISION,
    updatedAt: new Date(0).toISOString(),
    upstreams,
    customNodes,
    policy: { ...DEFAULT_MATERIALIZED_POLICY },
  };
}

function parseJsonArray<T>(raw: string | null, key: string): T[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error('not array');
    return value as T[];
  } catch {
    throw new ConfigStateError(`旧配置 ${key} 不是合法数组`);
  }
}

function legacyPrefix(upstream: Upstream): string {
  if (upstream.prefix === undefined) return `${upstream.name} | `;
  if (!upstream.prefix) return '';
  return upstream.prefix.endsWith(' | ') ? upstream.prefix : `${upstream.prefix} | `;
}

function defaultRevision(): string {
  return `r_${crypto.randomUUID()}`;
}

function parseDesiredConfig(raw: string, label: string): DesiredConfigV2 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ConfigStateError(`${label}不是合法 JSON`);
  }
  if (!isDesiredConfigV2(value)) {
    throw new ConfigStateError(`${label}结构无效`);
  }
  return value;
}

function isDesiredConfigV2(value: unknown): value is DesiredConfigV2 {
  if (!isRecord(value)) return false;
  return value.schemaVersion === DESIRED_CONFIG_SCHEMA_VERSION
    && typeof value.revision === 'string'
    && typeof value.updatedAt === 'string'
    && Array.isArray(value.upstreams)
    && Array.isArray(value.customNodes)
    && isRecord(value.policy)
    && (
      value.materializedArtifact === undefined
      || (
        isRecord(value.materializedArtifact)
        && value.materializedArtifact.schemaVersion === 1
        && typeof value.materializedArtifact.generatedAt === 'string'
        && typeof value.materializedArtifact.yaml === 'string'
      )
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
