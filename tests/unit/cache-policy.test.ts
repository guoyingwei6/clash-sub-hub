import { describe, expect, it, vi } from 'vitest';
import {
  cacheAgeSeconds,
  canAttemptRefresh,
  nextRetryAt,
  retryDelaySeconds,
} from '../../src/domain/cache-policy';
import { UpstreamDefinition } from '../../src/domain/config';
import { fetchUpstream } from '../../src/cron';
import { Env, UpstreamRuntimeState } from '../../src/types';
import {
  getUpstreamCache,
  getUpstreamState,
  upstreamCacheKey,
  upstreamSourceFingerprint,
} from '../../src/storage/upstream-cache';
import { FakeKv } from '../helpers/fake-kv';
import { stringifyYaml } from '../../src/yaml';

const upstream: UpstreamDefinition = {
  id: 'up_fixture',
  name: 'fixture-upstream',
  url: 'https://refresh.invalid/subscription',
  userAgent: 'fixture-client',
  prefix: 'fixture | ',
  fetchMode: 'server',
  required: true,
  providerOptions: { type: 'http' },
};

const settings = {
  defaultUA: 'fixture-client',
  fetchTimeout: 1,
  filterEnabled: true,
};

function environment(kv = new FakeKv()): Env {
  return {
    KV: kv as unknown as KVNamespace,
    ADMIN_PASSWORD: 'fixture-admin-password',
  };
}

function providerBody(nodeName = 'fixture-node'): string {
  return stringifyYaml({
    proxies: [{
      name: nodeName,
      type: 'ss',
      server: '192.0.2.40',
      port: 443,
      cipher: 'aes-128-gcm',
      password: 'fixture-password',
    }],
  });
}

describe('cache retry policy', () => {
  it('uses bounded exponential backoff', () => {
    expect([1, 2, 3, 7, 20].map(retryDelaySeconds)).toEqual([
      60,
      120,
      240,
      3600,
      3600,
    ]);
    expect(nextRetryAt(new Date('2026-01-01T00:00:00.000Z'), 2))
      .toBe('2026-01-01T00:02:00.000Z');
  });

  it('checks the retry boundary and cache age deterministically', () => {
    const state = stateAt('2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z');
    expect(canAttemptRefresh(state, new Date('2026-01-01T00:00:59.999Z'))).toBe(false);
    expect(canAttemptRefresh(state, new Date('2026-01-01T00:01:00.000Z'))).toBe(true);
    expect(canAttemptRefresh(state, new Date('2026-01-01T00:00:00.000Z'), true)).toBe(true);
    expect(cacheAgeSeconds(
      '2026-01-01T00:00:00.000Z',
      new Date('2026-01-01T00:01:01.500Z')
    )).toBe(61);
    expect(cacheAgeSeconds('invalid', new Date())).toBe(Number.POSITIVE_INFINITY);
  });

  it('does not invalidate raw cache when only prefix or exclude policy changes', async () => {
    const before = await upstreamSourceFingerprint(upstream);
    expect(await upstreamSourceFingerprint({
      ...upstream,
      prefix: 'different | ',
      exclude: 'expired',
    })).toBe(before);
    expect(await upstreamSourceFingerprint({
      ...upstream,
      url: 'https://other.invalid/subscription',
    })).not.toBe(before);
  });
});

describe('upstream refresh state machine', () => {
  it('stores cache and clears failure state after success', async () => {
    const kv = new FakeKv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(providerBody())));

    const state = await fetchUpstream(upstream, settings, environment(kv), {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(state).toMatchObject({
      lastSuccessAt: '2026-01-01T00:00:00.000Z',
      cacheUpdatedAt: '2026-01-01T00:00:00.000Z',
      nodeCount: 1,
      lastError: null,
      consecutiveFailures: 0,
      nextRetryAt: null,
    });
    expect(kv.peek(upstreamCacheKey(
      upstream.id,
      await upstreamSourceFingerprint(upstream)
    ))).not.toBeNull();
    expect((await getUpstreamCache(kv, upstream))?.content).toContain('fixture-node');
  });

  it('keeps the last-known-good cache when a later response has zero nodes', async () => {
    const kv = new FakeKv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(providerBody('good-node'))));
    await fetchUpstream(upstream, settings, environment(kv), {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(stringifyYaml({ proxies: [] }))));
    const failed = await fetchUpstream(upstream, settings, environment(kv), {
      force: true,
      now: () => new Date('2026-01-01T00:10:00.000Z'),
    });

    expect(failed.lastSuccessAt).toBe('2026-01-01T00:00:00.000Z');
    expect(failed.nodeCount).toBe(1);
    expect(failed.consecutiveFailures).toBe(1);
    expect(failed.nextRetryAt).toBe('2026-01-01T00:11:00.000Z');
    expect((await getUpstreamCache(kv, upstream))?.content).toContain('good-node');
  });

  it('does not retry before nextRetryAt and recovers when due', async () => {
    const kv = new FakeKv();
    const failingFetch = vi.fn(async () => {
      throw new Error('fixture network failure');
    });
    vi.stubGlobal('fetch', failingFetch);

    const failed = await fetchUpstream(upstream, settings, environment(kv), {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(failed.consecutiveFailures).toBe(1);
    const callsAfterFailure = failingFetch.mock.calls.length;

    const skipped = await fetchUpstream(upstream, settings, environment(kv), {
      now: () => new Date('2026-01-01T00:00:30.000Z'),
    });
    expect(skipped).toEqual(failed);
    expect(failingFetch).toHaveBeenCalledTimes(callsAfterFailure);

    const successfulFetch = vi.fn(async () => new Response(providerBody('recovered-node')));
    vi.stubGlobal('fetch', successfulFetch);
    const recovered = await fetchUpstream(upstream, settings, environment(kv), {
      now: () => new Date('2026-01-01T00:01:00.000Z'),
    });
    expect(successfulFetch).toHaveBeenCalledTimes(1);
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.lastError).toBeNull();
    expect((await getUpstreamState(kv, upstream))?.lastSuccessAt)
      .toBe('2026-01-01T00:01:00.000Z');
  });

  it('keeps source-versioned caches side by side during a URL change', async () => {
    const kv = new FakeKv();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(providerBody(url.includes('other.invalid') ? 'new-node' : 'old-node'));
    }));
    await fetchUpstream(upstream, settings, environment(kv), {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const changed = {
      ...upstream,
      url: 'https://other.invalid/subscription',
    };
    await fetchUpstream(changed, settings, environment(kv), {
      now: () => new Date('2026-01-01T00:01:00.000Z'),
    });

    expect((await getUpstreamCache(kv, upstream))?.content).toContain('old-node');
    expect((await getUpstreamCache(kv, changed))?.content).toContain('new-node');
    expect(upstreamCacheKey(
      upstream.id,
      await upstreamSourceFingerprint(upstream)
    )).not.toBe(upstreamCacheKey(
      changed.id,
      await upstreamSourceFingerprint(changed)
    ));
  });
});

function stateAt(lastAttemptAt: string, nextRetry: string): UpstreamRuntimeState {
  return {
    upstreamId: upstream.id,
    lastAttemptAt,
    lastSuccessAt: null,
    cacheUpdatedAt: null,
    nodeCount: 0,
    lastError: 'fixture failure',
    consecutiveFailures: 1,
    nextRetryAt: nextRetry,
    sourceFingerprint: 'fixture-fingerprint',
  };
}
