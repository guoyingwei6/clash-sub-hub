import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { importMerge } from '../../src/admin';
import { Env } from '../../src/types';
import {
  ACTIVE_CONFIG_KEY,
  loadActiveDesiredConfig,
} from '../../src/storage/config-state';
import { FakeKv } from '../helpers/fake-kv';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const desiredText = readFileSync(resolve(fixtures, 'merge-desired.yaml'), 'utf8');

function environment(): { env: Env; kv: FakeKv } {
  const kv = new FakeKv({ upstreams: '[]', 'custom-nodes': '[]' });
  return {
    kv,
    env: {
      KV: kv as unknown as KVNamespace,
      ADMIN_PASSWORD: 'fixture-admin-password',
    },
  };
}

function applyRequest(yaml: string): Request {
  return new Request('https://worker.invalid/api/import/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      yaml,
      action: 'apply',
      strategy: 'replace',
      baseRevision: 'legacy',
    }),
  });
}

describe('Merge activation cache readiness', () => {
  it('activates optional sources with explicit warnings when initial fetches fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('proxies: []')));
    const { env, kv } = environment();
    const response = await importMerge(applyRequest(desiredText), env);
    const body = await response.json() as {
      ok: boolean;
      cacheWarnings: string[];
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.cacheWarnings).toEqual(['alpha', 'gamma']);
    const active = await loadActiveDesiredConfig(kv);
    expect(active.revision).not.toBe('legacy');
    expect(active.materializedArtifact?.yaml).toContain('proxy-groups:');
  });

  it('keeps the old active config when a required source cannot be prepared', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('proxies: []')));
    const strictYaml = desiredText.replace(
      '  alpha:\n',
      '  alpha:\n    x-clash-sub-hub-required: true\n'
    );
    const { env, kv } = environment();
    const response = await importMerge(applyRequest(strictYaml), env);
    const body = await response.json() as {
      code: string;
      upstreams: string[];
    };

    expect(response.status).toBe(409);
    expect(body.code).toBe('CACHE_NOT_READY');
    expect(body.upstreams).toEqual(['alpha']);
    expect(kv.peek(ACTIVE_CONFIG_KEY)).toBeNull();
  });
});
