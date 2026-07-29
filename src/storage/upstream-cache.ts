import { UpstreamDefinition } from '../domain/config';
import { CachedUpstream, Upstream, UpstreamRuntimeState } from '../types';
import { TextKv } from './config-state';

const CACHE_PREFIX = 'cache:v2:';
const STATE_PREFIX = 'upstream-state:v2:';

export function upstreamCacheKey(
  upstreamId: string,
  sourceFingerprint?: string
): string {
  return sourceFingerprint
    ? `${CACHE_PREFIX}${upstreamId}:${sourceFingerprint}`
    : `${CACHE_PREFIX}${upstreamId}`;
}

export function upstreamStateKey(
  upstreamId: string,
  sourceFingerprint?: string
): string {
  return sourceFingerprint
    ? `${STATE_PREFIX}${upstreamId}:${sourceFingerprint}`
    : `${STATE_PREFIX}${upstreamId}`;
}

export async function upstreamSourceFingerprint(
  upstream: UpstreamDefinition
): Promise<string> {
  // Raw provider content only depends on the fetch endpoint and request
  // identity. Prefix/exclude are applied after parsing, so changing either must
  // not invalidate an otherwise usable cache.
  const source = JSON.stringify({
    url: upstream.url,
    userAgent: upstream.userAgent,
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source)
  );
  const hex = [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `src_${hex}`;
}

export async function getUpstreamState(
  kv: TextKv,
  upstream: UpstreamDefinition
): Promise<UpstreamRuntimeState | null> {
  const fingerprint = await upstreamSourceFingerprint(upstream);
  for (const key of [
    upstreamStateKey(upstream.id, fingerprint),
    upstreamStateKey(upstream.id),
  ]) {
    const raw = await kv.get(key);
    if (raw) {
      const parsed = parseState(raw);
      if (parsed && parsed.sourceFingerprint === fingerprint) {
        return parsed;
      }
    }
  }

  const legacy = await getLegacyUpstream(kv, upstream);
  if (!legacy) return null;
  const lastSuccessAt = legacy.lastUpdate ?? null;
  return {
    upstreamId: upstream.id,
    lastAttemptAt: lastSuccessAt,
    lastSuccessAt,
    cacheUpdatedAt: lastSuccessAt,
    nodeCount: legacy.nodeCount ?? 0,
    lastError: legacy.lastError ?? null,
    consecutiveFailures: legacy.lastError ? 1 : 0,
    nextRetryAt: null,
    sourceFingerprint: fingerprint,
  };
}

export async function putUpstreamState(
  kv: TextKv,
  state: UpstreamRuntimeState
): Promise<void> {
  await kv.put(
    upstreamStateKey(state.upstreamId, state.sourceFingerprint),
    JSON.stringify(state)
  );
}

export async function getUpstreamCache(
  kv: TextKv,
  upstream: UpstreamDefinition
): Promise<CachedUpstream | null> {
  const fingerprint = await upstreamSourceFingerprint(upstream);
  for (const key of [
    upstreamCacheKey(upstream.id, fingerprint),
    upstreamCacheKey(upstream.id),
  ]) {
    const raw = await kv.get(key);
    if (raw) {
      const parsed = parseCache(raw);
      if (parsed && parsed.sourceFingerprint === fingerprint) return parsed;
    }
  }

  const legacy = await getLegacyUpstream(kv, upstream);
  if (!legacy) return null;
  const content = await kv.get(`cache:${upstream.name}`);
  if (!content) return null;
  return {
    schemaVersion: 1,
    upstreamId: upstream.id,
    sourceFingerprint: fingerprint,
    updatedAt: legacy.lastUpdate ?? new Date(0).toISOString(),
    nodeCount: legacy.nodeCount ?? 0,
    content,
  };
}

export async function putUpstreamCache(
  kv: TextKv,
  cache: CachedUpstream
): Promise<void> {
  await kv.put(
    upstreamCacheKey(cache.upstreamId, cache.sourceFingerprint),
    JSON.stringify(cache)
  );
}

function parseState(raw: string): UpstreamRuntimeState | null {
  try {
    const value = JSON.parse(raw) as UpstreamRuntimeState;
    return value && typeof value.upstreamId === 'string'
      && typeof value.sourceFingerprint === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}

function parseCache(raw: string): CachedUpstream | null {
  try {
    const value = JSON.parse(raw) as CachedUpstream;
    return value?.schemaVersion === 1
      && typeof value.upstreamId === 'string'
      && typeof value.sourceFingerprint === 'string'
      && typeof value.content === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}

async function getLegacyUpstream(
  kv: TextKv,
  upstream: UpstreamDefinition
): Promise<Upstream | null> {
  const raw = await kv.get('upstreams');
  if (!raw) return null;
  try {
    const values = JSON.parse(raw) as Upstream[];
    if (!Array.isArray(values)) return null;
    const legacy = values.find((item) => item.name === upstream.name);
    if (!legacy || !legacyMatches(upstream, legacy)) return null;
    return legacy;
  } catch {
    return null;
  }
}

function legacyMatches(upstream: UpstreamDefinition, legacy: Upstream): boolean {
  const legacyPrefix = legacy.prefix === undefined
    ? `${legacy.name} | `
    : legacy.prefix
      ? (legacy.prefix.endsWith(' | ') ? legacy.prefix : `${legacy.prefix} | `)
      : '';
  return legacy.url === upstream.url
    && (legacy.userAgent || 'clash.meta') === upstream.userAgent
    && (legacy.exclude ?? undefined) === (upstream.exclude ?? undefined)
    && legacyPrefix === upstream.prefix;
}
