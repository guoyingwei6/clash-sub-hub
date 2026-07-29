import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyMergeImport, previewMergeImport } from '../../src/domain/merge-import';
import {
  ACTIVE_CONFIG_KEY,
  CONFIG_REVISION_TTL_SECONDS,
  ConfigConflictError,
  configRevisionKey,
  loadActiveDesiredConfig,
} from '../../src/storage/config-state';
import { FakeKv } from '../helpers/fake-kv';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const desiredText = readFileSync(resolve(fixtures, 'merge-desired.yaml'), 'utf8');

function legacyKv(): FakeKv {
  return new FakeKv({
    upstreams: JSON.stringify([
      {
        name: 'alpha',
        url: 'https://alpha.invalid/subscription',
        userAgent: 'fixture-client',
        prefix: 'alpha',
        lastUpdate: null,
        nodeCount: 0,
        lastError: null,
      },
      {
        name: 'beta',
        url: 'https://beta.invalid/subscription',
        userAgent: 'clash.meta',
        lastUpdate: null,
        nodeCount: 0,
        lastError: null,
      },
    ]),
    'custom-nodes': JSON.stringify([
      {
        name: 'fixture-custom',
        type: 'vless',
        server: '192.0.2.10',
        port: 443,
        uuid: '00000000-0000-4000-8000-000000000001',
        tls: true,
      },
      {
        name: 'fixture-ISP',
        type: 'socks5',
        server: '198.51.100.20',
        port: 1080,
        username: 'fixture-user',
        password: 'fixture-password',
      },
    ]),
  });
}

describe('Merge replace import', () => {
  it('previews a full replacement without writing KV', async () => {
    const kv = legacyKv();
    kv.clearOperations();

    const preview = await previewMergeImport(kv, desiredText);

    expect(preview.baseRevision).toBe('legacy');
    expect(preview.counts).toEqual({ upstreams: 2, customNodes: 3 });
    expect(preview.diff.upstreams.added).toEqual(['gamma']);
    expect(preview.diff.upstreams.deleted).toEqual(['beta']);
    expect(kv.operations.some((operation) => operation.type !== 'get')).toBe(false);
    expect(JSON.stringify(preview)).not.toContain('alpha.invalid');
    expect(JSON.stringify(preview)).not.toContain('fixture-password');
  });

  it('publishes an immutable revision before switching the complete active document', async () => {
    const kv = legacyKv();
    const result = await applyMergeImport(kv, desiredText, {
      strategy: 'replace',
      baseRevision: 'legacy',
      now: () => new Date('2026-01-02T03:04:05.000Z'),
      revisionFactory: () => 'fixture-r2',
    });

    expect(result.changed).toBe(true);
    expect(result.revision).toBe('fixture-r2');
    const writes = kv.operations.filter((operation) => operation.type === 'put');
    expect(writes.map((operation) => operation.key)).toEqual([
      configRevisionKey('fixture-r2'),
      ACTIVE_CONFIG_KEY,
    ]);
    expect(writes[0].expirationTtl).toBe(CONFIG_REVISION_TTL_SECONDS);
    expect(writes[1].expirationTtl).toBeUndefined();
    expect(JSON.parse(kv.peek(ACTIVE_CONFIG_KEY) || '{}')).toMatchObject({
      revision: 'fixture-r2',
      schemaVersion: 2,
    });

    const active = await loadActiveDesiredConfig(kv);
    expect(active.upstreams.map((item) => item.name)).toEqual(['alpha', 'gamma']);
    expect(active.customNodes.map((item) => item.name)).toEqual([
      'fixture-custom',
      'fixture-ISP',
      'fixture-new',
    ]);
  });

  it('is a no-op when the replacement already matches', async () => {
    const kv = legacyKv();
    await applyMergeImport(kv, desiredText, {
      strategy: 'replace',
      baseRevision: 'legacy',
      revisionFactory: () => 'fixture-r2',
    });
    kv.clearOperations();

    const result = await applyMergeImport(kv, desiredText, {
      strategy: 'replace',
      baseRevision: 'fixture-r2',
      revisionFactory: () => 'unused',
    });

    expect(result.changed).toBe(false);
    expect(result.revision).toBe('fixture-r2');
    expect(JSON.parse(kv.peek(ACTIVE_CONFIG_KEY) || '{}')).toMatchObject({
      revision: 'fixture-r2',
    });
    expect(kv.operations.some((operation) => operation.type === 'put')).toBe(false);
  });

  it('rejects a stale preview before publishing', async () => {
    const kv = legacyKv();
    await applyMergeImport(kv, desiredText, {
      strategy: 'replace',
      baseRevision: 'legacy',
      revisionFactory: () => 'fixture-r2',
    });
    kv.clearOperations();

    await expect(applyMergeImport(kv, desiredText, {
      strategy: 'replace',
      baseRevision: 'legacy',
      revisionFactory: () => 'fixture-r3',
    })).rejects.toBeInstanceOf(ConfigConflictError);
    expect(kv.operations.some((operation) => operation.type === 'put')).toBe(false);
  });

  it('keeps the old active revision if publishing the document fails', async () => {
    const kv = legacyKv();
    kv.failOnWrite(1);
    await expect(applyMergeImport(kv, desiredText, {
      strategy: 'replace',
      baseRevision: 'legacy',
      revisionFactory: () => 'fixture-r2',
    })).rejects.toThrow('fixture write 1 failed');
    expect(kv.peek(ACTIVE_CONFIG_KEY)).toBeNull();
  });

  it('does not activate a replacement when its preparation gate fails', async () => {
    const kv = legacyKv();
    await expect(applyMergeImport(kv, desiredText, {
      strategy: 'replace',
      baseRevision: 'legacy',
      revisionFactory: () => 'fixture-r2',
      prepare: async () => {
        throw new Error('fixture cache not ready');
      },
    })).rejects.toThrow('fixture cache not ready');
    expect(kv.peek(ACTIVE_CONFIG_KEY)).toBeNull();
    expect(kv.peek(configRevisionKey('fixture-r2'))).toBeNull();
  });

  it('keeps the old active revision if switching the pointer fails', async () => {
    const kv = legacyKv();
    kv.failOnWrite(2);
    await expect(applyMergeImport(kv, desiredText, {
      strategy: 'replace',
      baseRevision: 'legacy',
      revisionFactory: () => 'fixture-r2',
    })).rejects.toThrow('fixture write 2 failed');
    expect(kv.peek(ACTIVE_CONFIG_KEY)).toBeNull();
    expect(kv.peek(configRevisionKey('fixture-r2'))).not.toBeNull();
  });

  it('reads the legacy pointer layout during migration', async () => {
    const kv = legacyKv();
    await applyMergeImport(kv, desiredText, {
      strategy: 'replace',
      baseRevision: 'legacy',
      revisionFactory: () => 'fixture-r2',
    });
    const revisionDocument = kv.peek(configRevisionKey('fixture-r2'));
    expect(revisionDocument).not.toBeNull();

    await kv.put(ACTIVE_CONFIG_KEY, 'fixture-r2');
    expect((await loadActiveDesiredConfig(kv)).revision).toBe('fixture-r2');
  });

  it('rejects unsupported strategies without writing', async () => {
    const kv = legacyKv();
    await expect(applyMergeImport(kv, desiredText, {
      strategy: 'append',
      baseRevision: 'legacy',
    })).rejects.toThrow('strategy: replace');
    expect(kv.operations.some((operation) => operation.type === 'put')).toBe(false);
  });
});
