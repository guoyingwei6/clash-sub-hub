import { describe, expect, it, vi } from 'vitest';
import { refreshAll, refreshOne } from '../../src/admin';
import {
  ACTIVE_CONFIG_KEY,
  loadActiveDesiredConfig,
} from '../../src/storage/config-state';
import { Env } from '../../src/types';
import { stringifyYaml } from '../../src/yaml';
import { FakeKv } from '../helpers/fake-kv';
import {
  putUpstreamCache,
  upstreamSourceFingerprint,
} from '../../src/storage/upstream-cache';

describe('manual upstream refresh', () => {
  it('does not report success until the active Materialized artifact is rebuilt', async () => {
    const kv = new FakeKv({
      upstreams: JSON.stringify([{
        name: 'fixture-refresh',
        url: 'https://refresh.invalid/subscription',
        userAgent: 'fixture-client',
        lastUpdate: null,
        nodeCount: 0,
        lastError: null,
      }]),
      'custom-nodes': '[]',
    });
    const env: Env = {
      KV: kv as unknown as KVNamespace,
      ADMIN_PASSWORD: 'fixture-admin-password',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stringifyYaml({
      proxies: [{
        name: 'fixture-refreshed-node',
        type: 'ss',
        server: '192.0.2.88',
        port: 443,
        cipher: 'aes-128-gcm',
        password: 'fixture-password',
      }],
    }))));

    const response = await refreshOne('fixture-refresh', env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      nodeCount: 1,
      artifactReady: true,
    });

    const active = await loadActiveDesiredConfig(kv);
    expect(active.materializedArtifact?.yaml).toContain('fixture-refreshed-node');
    expect(kv.peek(ACTIVE_CONFIG_KEY)).not.toBeNull();
    expect(kv.operations.some((operation) =>
      operation.type === 'put'
      && operation.key.startsWith('config:v2:revision:')
    )).toBe(false);
  });

  it('rebuilds the artifact when only mirror cache content changes', async () => {
    const kv = new FakeKv({
      upstreams: JSON.stringify([{
        name: 'fixture-mirror-refresh',
        url: 'https://mirror-refresh.invalid/subscription',
        userAgent: 'fixture-client',
        localFetch: true,
        lastUpdate: null,
        nodeCount: 0,
        lastError: null,
      }]),
      'custom-nodes': '[]',
      'cache:fixture-mirror-refresh': stringifyYaml({
        proxies: [{
          name: 'fixture-old-mirror-node',
          type: 'ss',
          server: '192.0.2.91',
          port: 443,
          cipher: 'aes-128-gcm',
          password: 'fixture-password-old',
        }],
      }),
    });
    const env: Env = {
      KV: kv as unknown as KVNamespace,
      ADMIN_PASSWORD: 'fixture-admin-password',
    };

    const first = await refreshAll(env);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      ok: true,
      attempted: 0,
      failed: 0,
      artifactReady: true,
    });

    const config = await loadActiveDesiredConfig(kv);
    const upstream = config.upstreams[0];
    const replacement = stringifyYaml({
      proxies: [{
        name: 'fixture-new-mirror-node',
        type: 'ss',
        server: '192.0.2.92',
        port: 443,
        cipher: 'aes-128-gcm',
        password: 'fixture-password-new',
      }],
    });
    await putUpstreamCache(kv, {
      schemaVersion: 1,
      upstreamId: upstream.id,
      sourceFingerprint: await upstreamSourceFingerprint(upstream),
      updatedAt: new Date().toISOString(),
      nodeCount: 1,
      content: replacement,
    });

    const second = await refreshAll(env);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      ok: true,
      attempted: 0,
      failed: 0,
      artifactReady: true,
    });
    const active = await loadActiveDesiredConfig(kv);
    expect(active.materializedArtifact?.yaml).toContain(
      'fixture-new-mirror-node'
    );
    expect(active.materializedArtifact?.yaml).not.toContain(
      'fixture-old-mirror-node'
    );
  });
});
