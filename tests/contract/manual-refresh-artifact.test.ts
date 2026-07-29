import { describe, expect, it, vi } from 'vitest';
import { refreshOne } from '../../src/admin';
import {
  ACTIVE_CONFIG_KEY,
  loadActiveDesiredConfig,
} from '../../src/storage/config-state';
import { Env } from '../../src/types';
import { stringifyYaml } from '../../src/yaml';
import { FakeKv } from '../helpers/fake-kv';

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
});
