import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDesiredConfig } from '../../src/domain/config';
import {
  MergeValidationError,
  diffDesiredConfig,
  parseMergeYaml,
  serializeMergeConfig,
  upstreamIdForName,
} from '../../src/domain/merge';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const currentText = readFileSync(resolve(fixtures, 'merge-current.yaml'), 'utf8');
const desiredText = readFileSync(resolve(fixtures, 'merge-desired.yaml'), 'utf8');

describe('Merge normalization and diff', () => {
  it('reports add, update, delete and unchanged without exposing values', () => {
    const current = parseMergeYaml(currentText);
    const desired = parseMergeYaml(desiredText, current);
    const diff = diffDesiredConfig(current, desired);

    expect(diff.hasChanges).toBe(true);
    expect(diff.upstreams.added).toEqual(['gamma']);
    expect(diff.upstreams.deleted).toEqual(['beta']);
    expect(diff.upstreams.updated).toEqual([{
      name: 'alpha',
      changedFields: ['exclude', 'prefix', 'providerOptions', 'url', 'userAgent'],
    }]);
    expect(diff.customNodes.added).toEqual(['fixture-new']);
    expect(diff.customNodes.deleted).toEqual([]);
    expect(diff.customNodes.unchanged).toEqual(['fixture-ISP']);
    expect(diff.customNodes.updated).toEqual([{
      name: 'fixture-custom',
      changedFields: ['port'],
    }]);
    expect(diff.policyChangedFields).toEqual(['maxCacheAgeSeconds']);

    const preview = JSON.stringify(diff);
    expect(preview).not.toContain('alpha.invalid');
    expect(preview).not.toContain('fixture-password');
    expect(preview).not.toContain('00000000-0000-4000-8000-000000000001');
  });

  it('is idempotent after a full replacement', () => {
    const current = parseMergeYaml(currentText);
    const desired = parseMergeYaml(desiredText, current);
    expect(diffDesiredConfig(desired, desired)).toEqual({
      upstreams: {
        added: [],
        updated: [],
        deleted: [],
        unchanged: ['alpha', 'gamma'],
      },
      customNodes: {
        added: [],
        updated: [],
        deleted: [],
        unchanged: ['fixture-ISP', 'fixture-custom', 'fixture-new'],
      },
      policyChangedFields: [],
      hasChanges: false,
    });
  });

  it('round-trips the supported provider and node fields', () => {
    const desired = parseMergeYaml(desiredText);
    const roundTripped = parseMergeYaml(serializeMergeConfig(desired), desired);
    expect(roundTripped).toEqual(desired);
  });

  it('round-trips schema-validated materialized tuning without exposing values in diffs', () => {
    const parsed = parseMergeYaml([
      'x-clash-sub-hub:',
      '  policy:',
      '    domestic-nameservers: [https://dns-fixture.invalid/domestic]',
      '    foreign-nameservers: [https://dns-fixture.invalid/foreign]',
      '    tun-route-exclude-addresses: [203.0.113.0/24, 2001:db8::/32]',
      '    dns-fake-ip-filter-append: [\"+.fixture.invalid\"]',
    ].join('\n'));
    const serialized = serializeMergeConfig(parsed);

    expect(parseMergeYaml(serialized, parsed)).toEqual(parsed);
    expect(serialized).toContain('domestic-nameservers');
    expect(serialized).toContain('tun-route-exclude-addresses');
  });

  it('keeps a new Mirror identity stable across preview, stage and apply parses', () => {
    const text = [
      'proxy-providers:',
      '  fixture-mirror:',
      '    url: https://mirror.invalid/sub',
      '    x-clash-sub-hub-fetch-mode: mirror',
      '    x-clash-sub-hub-required: true',
    ].join('\n');
    const first = parseMergeYaml(text);
    const second = parseMergeYaml(text);

    expect(first.upstreams[0].id).toBe(upstreamIdForName('fixture-mirror'));
    expect(second.upstreams[0].id).toBe(first.upstreams[0].id);
    expect(serializeMergeConfig(first)).toContain(
      `x-clash-sub-hub-id: ${first.upstreams[0].id}`
    );
  });

  it('rejects invalid or duplicate explicit upstream identities', () => {
    expect(() => parseMergeYaml([
      'proxy-providers:',
      '  bad:',
      '    url: https://bad.invalid/sub',
      '    x-clash-sub-hub-id: predictable',
    ].join('\n'))).toThrow(MergeValidationError);

    const duplicateId = 'up_0123456789abcdef0123456789abcdef';
    expect(() => parseMergeYaml([
      'proxy-providers:',
      '  first:',
      '    url: https://first.invalid/sub',
      `    x-clash-sub-hub-id: ${duplicateId}`,
      '  second:',
      '    url: https://second.invalid/sub',
      `    x-clash-sub-hub-id: ${duplicateId}`,
    ].join('\n'))).toThrow('上游 id 重复');
  });

  it('normalizes defaults, extensions and revision metadata', () => {
    const draft = parseMergeYaml([
      'proxy-providers:',
      '  plain:',
      '    url: https://plain.invalid/sub',
      '    header:',
      '      User-Agent: fixture-client',
      '  mirrored:',
      '    url: http://mirror.invalid/sub',
      '    override:',
      '      additional-prefix: ""',
      '    header:',
      '      User-Agent: [null, fixture-mirror]',
      '    x-clash-sub-hub-fetch-mode: mirror',
      '    x-clash-sub-hub-required: false',
    ].join('\n'));

    expect(draft.upstreams[0]).toMatchObject({
      name: 'plain',
      userAgent: 'fixture-client',
      prefix: 'plain | ',
      fetchMode: 'server',
      required: false,
    });
    expect(draft.upstreams[1]).toMatchObject({
      name: 'mirrored',
      userAgent: 'fixture-mirror',
      prefix: '',
      fetchMode: 'mirror',
      required: false,
    });

    expect(createDesiredConfig(draft, 'fixture-revision', '2026-01-01T00:00:00.000Z'))
      .toMatchObject({
        revision: 'fixture-revision',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
  });

  it('supports empty provider and node sections', () => {
    const empty = parseMergeYaml('{}');
    expect(empty.upstreams).toEqual([]);
    expect(empty.customNodes).toEqual([]);
    expect(parseMergeYaml(serializeMergeConfig(empty))).toEqual(empty);
  });

  it.each([
    ['not-an-object', '- item'],
    ['invalid YAML', 'proxy-providers: ['],
    ['providers not an object', 'proxy-providers: []'],
    ['provider not an object', 'proxy-providers:\n  bad: value'],
    ['provider without URL', 'proxy-providers:\n  bad:\n    type: http'],
    ['malformed provider URL', 'proxy-providers:\n  bad:\n    url: not-a-url'],
    ['bad provider URL', 'proxy-providers:\n  bad:\n    type: http\n    url: file:///tmp/sub'],
    ['unsupported provider type', 'proxy-providers:\n  bad:\n    type: inline\n    url: https://bad.invalid/sub'],
    ['invalid provider prefix', [
      'proxy-providers:',
      '  bad:',
      '    url: https://bad.invalid/sub',
      '    override: { additional-prefix: 1 }',
    ].join('\n')],
    ['invalid provider exclude', [
      'proxy-providers:',
      '  bad:',
      '    url: https://bad.invalid/sub',
      '    exclude-filter: 1',
    ].join('\n')],
    ['invalid provider fetch mode', [
      'proxy-providers:',
      '  bad:',
      '    url: https://bad.invalid/sub',
      '    x-clash-sub-hub-fetch-mode: client',
    ].join('\n')],
    ['invalid provider required flag', [
      'proxy-providers:',
      '  bad:',
      '    url: https://bad.invalid/sub',
      '    x-clash-sub-hub-required: yes',
    ].join('\n')],
    ['invalid policy object', 'x-clash-sub-hub:\n  policy: value'],
    ['invalid policy filter', [
      'x-clash-sub-hub:',
      '  policy:',
      '    filter-upstream-info-nodes: yes',
    ].join('\n')],
    ['invalid missing cache policy', [
      'x-clash-sub-hub:',
      '  policy:',
      '    missing-cache: ignore',
    ].join('\n')],
    ['invalid max cache age', [
      'x-clash-sub-hub:',
      '  policy:',
      '    max-cache-age-seconds: 1',
    ].join('\n')],
    ['invalid nameserver URL', [
      'x-clash-sub-hub:',
      '  policy:',
      '    foreign-nameservers: [file:///tmp/dns]',
    ].join('\n')],
    ['invalid TUN exclusion', [
      'x-clash-sub-hub:',
      '  policy:',
      '    tun-route-exclude-addresses: [not-an-ip]',
    ].join('\n')],
    ['invalid fake IP filter', [
      'x-clash-sub-hub:',
      '  policy:',
      '    dns-fake-ip-filter-append: [\"bad domain\"]',
    ].join('\n')],
    ['proxies not an array', 'proxies: {}'],
    ['proxy not an object', 'proxies: [value]'],
    ['proxy without name', 'proxies:\n  - { type: socks5, server: 192.0.2.1, port: 1080 }'],
    ['proxy without type', 'proxies:\n  - { name: bad, server: 192.0.2.1, port: 1080 }'],
    ['proxy without server', 'proxies:\n  - { name: bad, type: socks5, port: 1080 }'],
    ['duplicate node name', [
      'proxies:',
      '  - { name: duplicate, type: socks5, server: 192.0.2.1, port: 1080 }',
      '  - { name: duplicate, type: socks5, server: 192.0.2.2, port: 1080 }',
    ].join('\n')],
    ['invalid node port', 'proxies:\n  - { name: bad, type: socks5, server: 192.0.2.1, port: 70000 }'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseMergeYaml(input)).toThrow(MergeValidationError);
  });
});
