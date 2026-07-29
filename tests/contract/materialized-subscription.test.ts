import { describe, expect, it } from 'vitest';
import { handleMerge, handleSubscription } from '../../src/subscription';
import { Env, ProxyNode } from '../../src/types';
import { FakeKv } from '../helpers/fake-kv';
import { parseYaml, stringifyYaml } from '../../src/yaml';
import { hashSubscriptionToken } from '../../src/domain/token';
import { ACTIVE_CONFIG_KEY } from '../../src/storage/config-state';
import {
  DEFAULT_MATERIALIZED_POLICY,
  MaterializedPolicy,
} from '../../src/domain/config';
import { upstreamIdForName } from '../../src/domain/merge';

const upstreamSourceA = 'https://contract-a.invalid/subscription';
const upstreamSourceB = 'https://contract-b.invalid/subscription';

function createEnvironment(
  options: {
    omitSecondCache?: boolean;
    allowProviderMode?: boolean;
    cacheTimestamp?: string;
    requiredUpstreams?: string[];
    policy?: MaterializedPolicy;
    firstNodeName?: string;
    firstPrefix?: string;
  } = {}
): Env {
  const freshTimestamp = options.cacheTimestamp ?? new Date().toISOString();
  const values: Record<string, string> = {
    users: JSON.stringify([
      {
        token: 'fixture-token',
        name: 'fixture-user',
        enabled: true,
        allowProviderMode: options.allowProviderMode === true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
    upstreams: JSON.stringify([
      {
        name: 'contract-a',
        url: upstreamSourceA,
        userAgent: 'fixture-client',
        prefix: options.firstPrefix,
        lastUpdate: freshTimestamp,
        nodeCount: 1,
        lastError: null,
      },
      {
        name: 'contract-b',
        url: upstreamSourceB,
        userAgent: 'fixture-client',
        lastUpdate: freshTimestamp,
        nodeCount: 1,
        lastError: null,
      },
    ]),
    'custom-nodes': JSON.stringify([
      {
        name: '🏠 家宽-ISP',
        type: 'socks5',
        server: '203.0.113.20',
        port: 1080,
        username: 'fixture-user',
        password: 'fixture-password',
        'dialer-proxy': '🚇 家宽中转',
      },
    ]),
    'cache:contract-a': stringifyYaml({
      proxies: [{
        name: options.firstNodeName ?? 'US fixture A',
        type: 'ss',
        server: '192.0.2.10',
        port: 443,
        cipher: 'aes-128-gcm',
        password: 'fixture-password-a',
      }],
    }),
  };
  if (!options.omitSecondCache) {
    values['cache:contract-b'] = stringifyYaml({
      proxies: [{
        name: 'JP fixture B',
        type: 'ss',
        server: '198.51.100.11',
        port: 443,
        cipher: 'aes-128-gcm',
        password: 'fixture-password-b',
      }],
    });
  }
  if (options.requiredUpstreams || options.policy) {
    const required = new Set(options.requiredUpstreams ?? []);
    values[ACTIVE_CONFIG_KEY] = JSON.stringify({
      schemaVersion: 2,
      revision: 'fixture-active',
      updatedAt: '2026-01-01T00:00:00.000Z',
      upstreams: [
        {
          id: upstreamIdForName('contract-a'),
          name: 'contract-a',
          url: upstreamSourceA,
          userAgent: 'fixture-client',
          prefix: 'contract-a | ',
          fetchMode: 'server',
          required: required.has('contract-a'),
          providerOptions: { type: 'http', interval: 3600 },
        },
        {
          id: upstreamIdForName('contract-b'),
          name: 'contract-b',
          url: upstreamSourceB,
          userAgent: 'fixture-client',
          prefix: 'contract-b | ',
          fetchMode: 'server',
          required: required.has('contract-b'),
          providerOptions: { type: 'http', interval: 3600 },
        },
      ],
      customNodes: JSON.parse(values['custom-nodes']),
      policy: options.policy ?? DEFAULT_MATERIALIZED_POLICY,
    });
  }

  return {
    KV: new FakeKv(values) as unknown as KVNamespace,
    ADMIN_PASSWORD: 'fixture-admin-password',
  };
}

describe('materialized subscription contract', () => {
  it('returns a complete deterministic config by default without provider URLs', async () => {
    const env = createEnvironment();
    const first = await handleSubscription('fixture-token', null, null, env);
    const kv = env.KV as unknown as FakeKv;
    const firstWrites = kv.operations.filter((operation) => operation.type === 'put');
    expect(firstWrites.some((operation) =>
      operation.key.startsWith('config:v2:revision:')
    )).toBe(false);
    expect(firstWrites.some((operation) =>
      operation.key === ACTIVE_CONFIG_KEY
    )).toBe(true);
    kv.clearOperations();
    const second = await handleSubscription('fixture-token', null, null, env);
    const firstText = await first.text();
    const secondText = await second.text();

    expect(first.status).toBe(200);
    expect(firstText).toBe(secondText);
    expect(first.headers.get('X-Clash-Artifact')).toBe('miss');
    expect(second.headers.get('X-Clash-Artifact')).toBe('hit');
    expect(kv.operations.some((operation) =>
      operation.type === 'get' && operation.key.startsWith('cache:')
    )).toBe(false);
    expect(kv.operations.some((operation) =>
      operation.type === 'get' && operation.key.startsWith('cache:v2:')
    )).toBe(false);
    expect(firstText).not.toContain(upstreamSourceA);
    expect(firstText).not.toContain(upstreamSourceB);

    const config = parseYaml<Record<string, unknown>>(firstText);
    expect(config['proxy-providers']).toBeUndefined();
    expect(config.dns).toBeTruthy();
    expect(config.tun).toBeTruthy();
    expect(Array.isArray(config.rules)).toBe(true);
    const nameserverPolicy = (config.dns as Record<string, unknown>)
      ['nameserver-policy'] as Record<string, unknown>;
    const geositePolicyKeys = Object.keys(nameserverPolicy)
      .filter((key) => key.startsWith('geosite:'));
    expect(geositePolicyKeys.join(',')).not.toMatch(
      /\b(?:claude|gemini|anthropic|perplexity)\b/
    );

    const proxies = config.proxies as ProxyNode[];
    const proxyNames = proxies.map((proxy) => proxy.name);
    expect(proxyNames).toEqual([
      'contract-a | US fixture A',
      'contract-b | JP fixture B',
      '🏠 家宽-ISP',
    ]);

    const groups = config['proxy-groups'] as Record<string, unknown>[];
    expect(new Set(groups.map((group) => group.name)).size).toBe(groups.length);
    expect(new Set(proxyNames).size).toBe(proxyNames.length);
    const manual = groups.find((group) => group.name === '节点选择');
    expect(manual?.proxies).toEqual(expect.arrayContaining(proxyNames));
    const automatic = groups.find((group) => group.name === '⚡️ 自动选择');
    expect(automatic?.proxies).toEqual([
      'contract-a | US fixture A',
      'contract-b | JP fixture B',
    ]);
    expect(automatic?.proxies).not.toContain('🏠 家宽-ISP');
    expect(groups.every((group) => !('use' in group))).toBe(true);
    assertGroupReferencesExist(groups, proxyNames);
    assertRuleTargetsExist(config.rules as string[], groups);

    const isp = proxies.find((proxy) => proxy.name === '🏠 家宽-ISP');
    expect(groups.some((group) => group.name === isp?.['dialer-proxy'])).toBe(true);
  });

  it('applies only schema-validated DNS and TUN tuning fields', async () => {
    const policy: MaterializedPolicy = {
      ...DEFAULT_MATERIALIZED_POLICY,
      domesticNameservers: ['https://dns-fixture.invalid/domestic'],
      foreignNameservers: ['https://dns-fixture.invalid/foreign'],
      tunRouteExcludeAddresses: ['203.0.113.0/24'],
      dnsFakeIpFilterAppend: ['+.fixture.invalid'],
    };
    const response = await handleSubscription(
      'fixture-token',
      null,
      null,
      createEnvironment({ policy })
    );
    const config = parseYaml<Record<string, unknown>>(await response.text());
    const dns = config.dns as Record<string, unknown>;
    const tun = config.tun as Record<string, unknown>;
    const nameserverPolicy = dns['nameserver-policy'] as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(dns.nameserver).toEqual(['https://dns-fixture.invalid/foreign']);
    expect(dns['proxy-server-nameserver'])
      .toEqual(['https://dns-fixture.invalid/domestic']);
    expect(nameserverPolicy['geosite:private,cn'])
      .toEqual(['https://dns-fixture.invalid/domestic']);
    expect(dns['fake-ip-filter']).toContain('+.fixture.invalid');
    expect(tun['route-exclude-address']).toContain('203.0.113.0/24');
  });

  it('blocks Provider and Merge URL disclosure unless the user is explicitly trusted', async () => {
    const blockedProvider = await handleSubscription(
      'fixture-token',
      null,
      'provider',
      createEnvironment()
    );
    const blockedFull = await handleSubscription(
      'fixture-token',
      null,
      'full',
      createEnvironment()
    );
    const blockedMerge = await handleMerge('fixture-token', createEnvironment());
    expect(blockedProvider.status).toBe(403);
    expect(blockedFull.status).toBe(403);
    expect(blockedMerge.status).toBe(403);
    expect(await blockedProvider.text()).not.toContain(upstreamSourceA);
    expect(await blockedMerge.text()).not.toContain(upstreamSourceA);

    const trusted = createEnvironment({ allowProviderMode: true });
    const provider = await handleSubscription('fixture-token', null, 'provider', trusted);
    const merge = await handleMerge('fixture-token', trusted);
    expect(await provider.text()).toContain(upstreamSourceA);
    expect(await merge.text()).toContain(upstreamSourceB);
  });

  it('fails closed when a required upstream cache is missing', async () => {
    const response = await handleSubscription(
      'fixture-token',
      null,
      null,
      createEnvironment({
        omitSecondCache: true,
        requiredUpstreams: ['contract-b'],
      })
    );
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(text).not.toContain('contract-b');
    expect(text).not.toContain(upstreamSourceB);
  });

  it('serves or rejects stale required caches according to the active policy', async () => {
    const staleTimestamp = '2000-01-01T00:00:00.000Z';
    const strict = await handleSubscription('fixture-token', null, null, createEnvironment({
      cacheTimestamp: staleTimestamp,
      requiredUpstreams: ['contract-a'],
      policy: {
        ...DEFAULT_MATERIALIZED_POLICY,
        missingCache: 'fail',
        maxCacheAgeSeconds: 60,
      },
    }));
    expect(strict.status).toBe(503);
    expect(await strict.text()).not.toContain('US fixture A');

    const resilient = await handleSubscription('fixture-token', null, null, createEnvironment({
      cacheTimestamp: staleTimestamp,
      requiredUpstreams: ['contract-a'],
      policy: {
        ...DEFAULT_MATERIALIZED_POLICY,
        missingCache: 'serve-stale',
        maxCacheAgeSeconds: 60,
      },
    }));
    const text = await resilient.text();
    expect(resilient.status).toBe(200);
    const config = parseYaml<Record<string, unknown>>(text);
    expect((config.proxies as ProxyNode[]).map((node) => node.name))
      .toContain('contract-a | US fixture A');
    const manual = (config['proxy-groups'] as Record<string, unknown>[])
      .find((group) => group.name === '节点选择');
    expect(manual?.proxies).toContain('contract-a | US fixture A');
  });

  it('applies per-user upstream and custom-node permissions to materialized nodes', async () => {
    const env = createEnvironment();
    const users = JSON.parse(await env.KV.get('users') || '[]');
    users[0].allowedUpstreams = ['contract-a'];
    users[0].allowedCustomNodes = [];
    await env.KV.put('users', JSON.stringify(users));

    const response = await handleSubscription('fixture-token', null, 'nodes', env);
    const config = parseYaml<{ proxies: ProxyNode[] }>(await response.text());
    expect(config.proxies.map((node) => node.name)).toEqual([
      'contract-a | US fixture A',
    ]);
  });

  it('returns a clear unavailable response instead of an empty materialized config', async () => {
    const env = createEnvironment();
    const users = JSON.parse(await env.KV.get('users') || '[]');
    users[0].allowedUpstreams = [];
    users[0].allowedCustomNodes = [];
    await env.KV.put('users', JSON.stringify(users));

    const response = await handleSubscription('fixture-token', null, 'nodes', env);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('没有可用节点');
  });

  it('does not let an untrusted provider shadow a same-named custom node', async () => {
    const env = createEnvironment({
      firstNodeName: '🏠 家宽-ISP',
      firstPrefix: '',
    });
    const users = JSON.parse(await env.KV.get('users') || '[]');
    users[0].filterNodes = false;
    await env.KV.put('users', JSON.stringify(users));

    const response = await handleSubscription('fixture-token', null, 'nodes', env);
    const config = parseYaml<{ proxies: ProxyNode[] }>(await response.text());
    const matches = config.proxies.filter((node) => node.name === '🏠 家宽-ISP');
    expect(matches).toHaveLength(1);
    expect(matches[0].server).toBe('203.0.113.20');
  });

  it('returns the same forbidden response for an unknown token', async () => {
    const response = await handleSubscription('unknown', null, null, createEnvironment());
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('无效的订阅链接');
  });

  it('accepts hashed tokens and does not distinguish disabled users', async () => {
    const token = 'fixture-hashed-token';
    const env = createEnvironment();
    const user = {
      id: 'usr_fixture',
      tokenHash: await hashSubscriptionToken(token),
      tokenPrefix: 'fixture-',
      name: 'fixture-hashed-user',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await env.KV.put('users', JSON.stringify([user]));
    expect((await handleSubscription(token, null, null, env)).status).toBe(200);

    await env.KV.put('users', JSON.stringify([{ ...user, enabled: false }]));
    const disabled = await handleSubscription(token, null, null, env);
    const unknown = await handleSubscription('unknown', null, null, env);
    expect(disabled.status).toBe(403);
    expect(await disabled.text()).toBe(await unknown.text());
  });
});

function assertGroupReferencesExist(
  groups: Record<string, unknown>[],
  proxyNames: string[]
): void {
  const builtins = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS']);
  const known = new Set([
    ...proxyNames,
    ...groups.map((group) => String(group.name)),
    ...builtins,
  ]);

  for (const group of groups) {
    const members = Array.isArray(group.proxies) ? group.proxies : [];
    for (const member of members) {
      expect(known.has(String(member)), `${String(group.name)} -> ${String(member)}`).toBe(true);
    }
  }
}

function assertRuleTargetsExist(
  rules: string[],
  groups: Record<string, unknown>[]
): void {
  const targets = new Set([
    ...groups.map((group) => String(group.name)),
    'DIRECT',
    'REJECT',
    'REJECT-DROP',
    'PASS',
  ]);
  for (const rule of rules) {
    const parts = rule.split(',');
    const target = parts.at(-1) === 'no-resolve' ? parts.at(-2) : parts.at(-1);
    expect(targets.has(String(target)), `rule target: ${rule}`).toBe(true);
  }
}
