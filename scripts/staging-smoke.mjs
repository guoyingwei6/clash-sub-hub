#!/usr/bin/env node
/**
 * Isolated staging smoke test.
 *
 * Required environment variables:
 *   CLASH_SUB_HUB_URL
 *   ADMIN_PASSWORD
 *   MIRROR_UPLOAD_SECRET
 *   MIHOMO_BIN
 *   STAGING_PROVIDER_URL
 *
 * The target must be an HTTPS host beginning with "clash-sub-hub-staging.".
 * The script uses only repository fixtures and never prints credentials,
 * subscription tokens, fixture node secrets, or source URLs.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mergePath = resolve(root, 'tests/fixtures/staging-merge.yaml');
const providerPath = resolve(root, 'tests/fixtures/staging-provider.yaml');
const providerV2Path = resolve(root, 'tests/fixtures/staging-provider-v2.yaml');
const expectedStagingHost =
  'clash-sub-hub-staging.guoyingwei6.workers.dev';
const expectedProviderHost =
  'clash-sub-hub-staging-provider.guoyingwei6.workers.dev';
const baseUrl = new URL(process.env.CLASH_SUB_HUB_URL || '');
const adminPassword = process.env.ADMIN_PASSWORD;
const mirrorSecret = process.env.MIRROR_UPLOAD_SECRET;
const mihomoBin = process.env.MIHOMO_BIN;
const stagingProviderUrl = new URL(process.env.STAGING_PROVIDER_URL || '');

if (
  baseUrl.protocol !== 'https:'
  || baseUrl.hostname !== expectedStagingHost
  || baseUrl.port !== ''
  || baseUrl.username !== ''
  || baseUrl.password !== ''
  || baseUrl.pathname !== '/'
  || baseUrl.search !== ''
  || baseUrl.hash !== ''
  || !adminPassword
  || !mirrorSecret
  || !mihomoBin
  || !isAbsolute(mihomoBin)
  || stagingProviderUrl.protocol !== 'https:'
  || stagingProviderUrl.hostname !== expectedProviderHost
  || stagingProviderUrl.port !== ''
  || stagingProviderUrl.username !== ''
  || stagingProviderUrl.password !== ''
  || stagingProviderUrl.pathname !== '/provider.yaml'
  || stagingProviderUrl.search !== ''
  || stagingProviderUrl.hash !== ''
) {
  fail('需要精确白名单 Staging/Provider URL、ADMIN_PASSWORD、MIRROR_UPLOAD_SECRET 和绝对 MIHOMO_BIN');
}

const mergeTemplate = await readFile(mergePath, 'utf8');
const providerYaml = await readFile(providerPath, 'utf8');
const providerV2Yaml = await readFile(providerV2Path, 'utf8');
const mergeDocument = parseYaml(mergeTemplate);
const providers = mergeDocument['proxy-providers'] || {};
const mirrorEntry = Object.entries(providers)
  .find(([, provider]) =>
    provider['x-clash-sub-hub-fetch-mode'] === 'mirror'
  );
const serverEntry = Object.entries(providers)
  .find(([, provider]) =>
    provider['x-clash-sub-hub-fetch-mode'] === 'server'
  );
const [upstreamName, rawProvider] = mirrorEntry || [];
if (!upstreamName || !rawProvider) fail('Staging Merge fixture 缺少上游');
if (!serverEntry) fail('Staging Merge fixture 缺少 server 上游');
const serverSwitchAt = Date.now() + 30_000;
const serverSourceUrl = new URL(stagingProviderUrl);
serverSourceUrl.searchParams.set('switchAt', String(serverSwitchAt));
serverEntry[1].url = serverSourceUrl.toString();
const mergeYaml = stringifyYaml(mergeDocument);

const upstream = {
  id: rawProvider['x-clash-sub-hub-id'],
  name: upstreamName,
  url: rawProvider.url,
  userAgent: rawProvider.header?.['User-Agent']?.[0] || 'clash.meta',
  prefix: rawProvider.override?.['additional-prefix'] || '',
  fetchMode: rawProvider['x-clash-sub-hub-fetch-mode'],
  required: rawProvider['x-clash-sub-hub-required'] === true,
  providerOptions: {
    type: 'http',
    interval: Number(rawProvider.interval || 3600),
  },
};
if (
  typeof upstream.id !== 'string'
  || upstream.fetchMode !== 'mirror'
  || upstream.required !== true
) {
  fail('Staging Mirror fixture 结构无效');
}

const login = await request('/api/admin/session', {
  method: 'POST',
  headers: { Authorization: `Bearer ${adminPassword}` },
});
expectStatus(login, 200, '短期会话创建');
const loginResult = await safeJson(login.clone(), '短期会话创建');
assertStagingEnvironment(loginResult, '短期会话创建');
const setCookie = login.headers.get('set-cookie') || '';
if (
  !setCookie.includes('HttpOnly')
  || !setCookie.includes('Secure')
  || !setCookie.includes('SameSite=Strict')
) {
  fail('短期会话 Cookie 缺少安全属性');
}
const sessionCookie = setCookie.split(';', 1)[0];
const sessionHeaders = { Cookie: sessionCookie };

const sessionCheck = await request('/api/admin/session', {
  headers: sessionHeaders,
});
expectStatus(sessionCheck, 200, '短期会话校验');
assertStagingEnvironment(
  await safeJson(sessionCheck, '短期会话校验'),
  '短期会话校验'
);

await removePriorSmokeUsers(sessionHeaders);
await resetStagingDesiredConfig(sessionHeaders, mergeDocument);

const stagedEnvelope = JSON.stringify({ upstream, content: providerYaml });
const staged = await signedMirrorRequest(
  `/mirror-stage/${encodeURIComponent(upstream.id)}`,
  upstream.id,
  stagedEnvelope,
  'application/json'
);
expectStatus(staged, 200, 'Mirror 预载');
const stagedResult = await safeJson(staged, 'Mirror 预载');
if (stagedResult.ok !== true || stagedResult.staged !== true) {
  fail('Mirror 预载未确认成功');
}

const { preview, applied } = await applyMergeWithConflictRetry(
  mergeYaml,
  sessionHeaders,
  'Merge 全量替换'
);
if (
  !preview.baseRevision
  || preview.action !== 'preview'
  || applied.diff?.hasChanges !== true
  || applied.diff?.upstreams?.added?.length !== 2
  || applied.diff?.customNodes?.added?.length !== 4
  || applied.diff?.customNodes?.deleted?.length !== 1
) {
  fail('Merge 应用结果未证明从唯一最小基线执行全量替换');
}

if (
  applied.ok !== true
  || applied.artifact?.ok !== true
  || applied.changed !== true
  || (applied.cacheWarnings || []).length !== 0
) {
  fail('Merge 应用后缓存或 Materialized artifact 未就绪');
}

const created = await adminJson(
  '/api/users',
  { method: 'POST', body: { name: 'staging-smoke-user' } },
  sessionHeaders,
  '创建测试用户'
);
if (typeof created.token !== 'string' || created.token.length < 32) {
  fail('测试用户 token 未安全生成');
}
let activeToken = created.token;
let smokeUserId = '';

const users = await adminJson(
  '/api/users',
  {},
  sessionHeaders,
  '读取测试用户'
);
const smokeUser = users.find((user) => user.name === 'staging-smoke-user');
if (
  !smokeUser?.id
  || JSON.stringify(users).includes(activeToken)
  || JSON.stringify(users).includes('tokenHash')
) {
  fail('用户列表泄露 token 或缺少稳定 ID');
}
smokeUserId = smokeUser.id;

const customNodes = structuredClone(mergeDocument.proxies || []);
const initialMirrorNodes = withPrefix(
  parseYaml(providerYaml).proxies || [],
  'fixture-mirror | '
);
const updatedMirrorNodes = withPrefix(
  parseYaml(providerV2Yaml).proxies || [],
  'fixture-mirror | '
);
const serverV1Nodes = [{
  name: 'fixture-server | staging fixture server refresh',
  type: 'socks5',
  server: '192.0.2.200',
  port: 1080,
  udp: true,
}];
const serverV2Nodes = [{
  name: 'fixture-server | staging fixture server refreshed v2',
  type: 'socks5',
  server: '192.0.2.201',
  port: 2080,
  udp: true,
}];
const initialProviderNodeNames = [
  'fixture-mirror | US fixture mirror',
  'fixture-mirror | JP fixture mirror',
];
const serverNodeNames = ['fixture-server | staging fixture server refresh'];
const initialMaterialized = await fetchMaterialized(
  activeToken,
  '初始 Materialized 订阅'
);
assertMaterialized(
  initialMaterialized,
  [...initialMirrorNodes, ...serverV1Nodes, ...customNodes],
  [...initialProviderNodeNames, ...serverNodeNames]
);

const activeMirror = await signedMirrorRequest(
  `/mirror/${encodeURIComponent(upstream.id)}`,
  upstream.id,
  providerV2Yaml,
  'text/yaml'
);
expectStatus(activeMirror, 200, '活动 Mirror V2 上传');
const activeMirrorResult = await safeJson(activeMirror, '活动 Mirror V2 上传');
if (
  activeMirrorResult.ok !== true
  || activeMirrorResult.artifactReady !== true
) {
  fail('活动 Mirror V2 未同步重建 artifact');
}

const updatedProviderNodeNames = [
  'fixture-mirror | US fixture mirror',
  'fixture-mirror | DE fixture mirror',
  ...serverNodeNames,
];
const updatedMaterialized = await fetchMaterialized(
  activeToken,
  'Mirror 更新后的同链接订阅'
);
assertMaterialized(
  updatedMaterialized,
  [...updatedMirrorNodes, ...serverV1Nodes, ...customNodes],
  updatedProviderNodeNames
);
if (
  updatedMaterialized.proxyNames.includes('fixture-mirror | JP fixture mirror')
) {
  fail('Mirror V2 更新后旧节点仍残留');
}

const serverWaitMilliseconds = serverSwitchAt + 1_000 - Date.now();
if (serverWaitMilliseconds > 0) {
  await wait(serverWaitMilliseconds);
}
const refresh = await adminJson(
  '/api/refresh',
  { method: 'POST' },
  sessionHeaders,
  '全量刷新'
);
if (process.env.STAGING_SMOKE_DEBUG === '1') {
  console.error(JSON.stringify({
    stagingRefresh: true,
    ok: refresh.ok === true,
    artifactReady: refresh.artifactReady === true,
    attempted: Number(refresh.attempted ?? -1),
    succeeded: Number(refresh.succeeded ?? -1),
    failed: Number(refresh.failed ?? -1),
  }));
}
if (
  refresh.ok !== true
  || refresh.artifactReady !== true
  || refresh.attempted !== 1
  || refresh.succeeded !== 1
  || refresh.failed !== 0
) {
  fail('全量刷新没有真实拉取唯一 server 上游');
}

const finalMaterialized = await fetchMaterialized(
  activeToken,
  'server 刷新后的同链接订阅'
);
assertMaterialized(
  finalMaterialized,
  [...updatedMirrorNodes, ...serverV2Nodes, ...customNodes],
  [
    'fixture-mirror | US fixture mirror',
    'fixture-mirror | DE fixture mirror',
    'fixture-server | staging fixture server refreshed v2',
  ]
);
if (
  finalMaterialized.proxyNames.includes(
    'fixture-server | staging fixture server refresh'
  )
) {
  fail('server V2 刷新后旧节点仍残留');
}
const materializedText = finalMaterialized.text;
const materializedDocument = finalMaterialized.document;
const proxyNames = finalMaterialized.proxyNames;
const groups = materializedDocument['proxy-groups'];
const mihomoValidation = await validateWithMihomo(
  mihomoBin,
  materializedText
);

const providerDenied = await request(
  `/sub/${encodeURIComponent(activeToken)}?mode=provider`
);
expectStatus(providerDenied, 403, 'Provider 默认拒绝');

const rotated = await adminJson(
  `/api/users/${encodeURIComponent(smokeUserId)}/rotate`,
  { method: 'POST' },
  sessionHeaders,
  '轮换测试用户 token'
);
if (typeof rotated.token !== 'string' || rotated.token === activeToken) {
  fail('token 轮换未生成新值');
}
const oldTokenResponse = await request(
  `/sub/${encodeURIComponent(activeToken)}`
);
expectStatus(oldTokenResponse, 403, '旧 token 失效');
activeToken = rotated.token;
expectStatus(
  await request(`/sub/${encodeURIComponent(activeToken)}`),
  200,
  '新 token 生效'
);

await adminJson(
  `/api/users/${encodeURIComponent(smokeUserId)}`,
  { method: 'PUT', body: { enabled: false } },
  sessionHeaders,
  '禁用测试用户'
);
expectStatus(
  await request(`/sub/${encodeURIComponent(activeToken)}`),
  403,
  '禁用后订阅失效'
);
await adminJson(
  `/api/users/${encodeURIComponent(smokeUserId)}`,
  { method: 'PUT', body: { enabled: true } },
  sessionHeaders,
  '重新启用测试用户'
);
expectStatus(
  await request(`/sub/${encodeURIComponent(activeToken)}`),
  200,
  '重新启用后订阅恢复'
);
await adminJson(
  `/api/users/${encodeURIComponent(smokeUserId)}`,
  { method: 'DELETE' },
  sessionHeaders,
  '删除仍启用的测试用户'
);
expectStatus(
  await request(`/sub/${encodeURIComponent(activeToken)}`),
  403,
  '删除后订阅失效'
);

const logout = await request('/api/admin/session', {
  method: 'DELETE',
  headers: sessionHeaders,
});
expectStatus(logout, 200, '清理短期会话');
if (!(logout.headers.get('set-cookie') || '').includes('Max-Age=0')) {
  fail('退出未清除浏览器会话');
}

console.log(JSON.stringify({
  ok: true,
  target: baseUrl.hostname,
  checks: {
    shortSession: true,
    mirrorStage: true,
    replaceImport: true,
    activeMirror: true,
    refresh: true,
    sameLinkArtifactUpdate: true,
    materialized: true,
    providerDenied: true,
    tokenRotateDisableEnableDelete: true,
    logout: true,
    mihomo: mihomoValidation.ok,
  },
  counts: {
    proxies: proxyNames.length,
    groups: groups.length,
    rules: materializedDocument.rules.length,
  },
  mihomoVersion: mihomoValidation.version,
  sourceUrlLeak: false,
}, null, 2));

function assertStagingEnvironment(result, label) {
  if (result?.deploymentEnvironment !== 'staging') {
    fail(`${label} 未确认 deploymentEnvironment=staging，已在写入前停止`);
  }
}

async function resetStagingDesiredConfig(headers, target) {
  const resetNode = structuredClone(target.proxies[0]);
  resetNode.name = `🛠 staging-reset-${randomBytes(6).toString('hex')}`;
  const resetYaml = stringifyYaml({
    proxies: [resetNode],
    'x-clash-sub-hub': target['x-clash-sub-hub'],
  });
  const { preview, applied } = await applyMergeWithConflictRetry(
    resetYaml,
    headers,
    'Staging 最小基线'
  );
  if (!preview.baseRevision) fail('Staging 最小基线缺少 revision');
  if (
    applied.ok !== true
    || applied.artifact?.ok !== true
    || applied.changed !== true
  ) {
    fail('Staging 最小基线未就绪');
  }
}

async function applyMergeWithConflictRetry(yaml, headers, label) {
  const maxAttempts = 12;
  let previousConflictRevision = null;
  const preview = await adminJson(
    '/api/import/merge',
    { method: 'POST', body: { yaml, action: 'preview' } },
    headers,
    `${label}预览`
  );
  let baseRevision = preview.baseRevision;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await request('/api/import/merge', {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        yaml,
        action: 'apply',
        strategy: 'replace',
        baseRevision,
      }),
    });
    if (response.status === 409) {
      const conflict = await safeJson(response, `${label} 409`);
      if (conflict.code === 'CACHE_NOT_READY') {
        if (process.env.STAGING_SMOKE_DEBUG === '1') {
          console.error(JSON.stringify({
            stagingCacheNotReady: true,
            label,
            attempt,
            upstreamCount: Array.isArray(conflict.upstreams)
              ? conflict.upstreams.length
              : null,
            mirrorUnready:
              conflict.upstreams?.includes('fixture-mirror') === true,
            serverUnready:
              conflict.upstreams?.includes('fixture-server') === true,
          }));
        }
        await wait(Math.min(5_000, 1_000 * attempt));
        continue;
      }
      if (process.env.STAGING_SMOKE_DEBUG === '1') {
        console.error(JSON.stringify({
          stagingConflict: true,
          label,
          attempt,
          previewMatchesCurrent:
            baseRevision === conflict.currentRevision,
          currentStable:
            previousConflictRevision === null
            || previousConflictRevision === conflict.currentRevision,
        }));
      }
      previousConflictRevision = conflict.currentRevision ?? null;
      if (!conflict.currentRevision) {
        fail(`${label} 返回无法识别的 409`);
      }
      baseRevision = conflict.currentRevision;
      await wait(Math.min(5_000, 1_000 * attempt));
      continue;
    }
    expectStatus(response, 200, `${label}应用`);
    return {
      preview,
      applied: await safeJson(response, `${label}应用`),
    };
  }
  fail(`${label}在 Staging 就绪窗口内持续返回 409`);
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function fetchMaterialized(token, label) {
  const response = await request(`/sub/${encodeURIComponent(token)}`);
  expectStatus(response, 200, label);
  if (response.headers.get('X-Clash-Artifact') !== 'hit') {
    fail(`${label} 未命中活动配置内的 Materialized artifact`);
  }
  const text = await response.text();
  let document;
  try {
    document = parseYaml(text);
  } catch {
    fail(`${label} YAML 无法解析`);
  }
  return {
    text,
    document,
    proxies: document.proxies || [],
    proxyNames: (document.proxies || []).map((proxy) => proxy.name),
  };
}

function assertMaterialized(result, expectedNodes, expectedProviderNodeNames) {
  const { text, document, proxies, proxyNames } = result;
  const groups = document['proxy-groups'] || [];
  const expectedNodeNames = expectedNodes.map((node) => node.name);
  const expectedGroupNames = [
    '⚡️ 自动选择',
    '节点选择',
    '优先自建',
    '🏠 家宽',
    '🚇 家宽中转',
    '谷歌服务',
    'YouTube',
    '电报消息',
    'AI',
    'TikTok',
    'X(Twitter)',
    '微软服务',
    '苹果服务',
    '邮件',
    '广告过滤',
    '全局直连',
    '全局拦截',
    '漏网之鱼',
  ];
  const expectedRuleProviders = [
    'reject',
    'apple',
    'Microsoft',
    'google',
    'proxy',
    'direct',
    'private',
    'gfw',
    'tld-not-cn',
    'telegramcidr',
    'cncidr',
    'lancidr',
    'applications',
    'Twitter',
    'YouTube',
    'AI',
    'TikTok',
  ];
  const manual = groups.find((group) => group.name === '节点选择');
  const automatic = groups.find((group) => group.name === '⚡️ 自动选择');
  const relay = groups.find((group) => group.name === '🚇 家宽中转');
  const priority = groups.find((group) => group.name === '优先自建');
  const expectedManual = [
    '🏠 家宽',
    '优先自建',
    '🚇 家宽中转',
    '全局直连',
    ...expectedNodeNames,
  ];
  const dns = document.dns || {};
  const tun = document.tun || {};
  const rules = document.rules || [];
  const ruleProviderNames = Object.keys(document['rule-providers'] || {});
  const common = [
    '优先自建',
    '⚡️ 自动选择',
    '节点选择',
    '🏠 家宽',
    '全局直连',
  ];
  const expectedGroupProxies = {
    '⚡️ 自动选择': expectedProviderNodeNames,
    '节点选择': expectedManual,
    '优先自建': [
      '🛠 自建-Reality',
      '🛠 自建-TUIC',
      '🛠 Rabisu-Reality',
      '🚇 家宽中转',
    ],
    '🏠 家宽': ['🏠 家宽-ISP'],
    '🚇 家宽中转': expectedProviderNodeNames,
    '谷歌服务': common,
    YouTube: common,
    '电报消息': common,
    AI: ['🏠 家宽', '优先自建', '⚡️ 自动选择', '节点选择'],
    TikTok: common,
    'X(Twitter)': common,
    '微软服务': ['全局直连', '⚡️ 自动选择', '节点选择'],
    '苹果服务': common,
    '邮件': ['节点选择', '优先自建', '⚡️ 自动选择'],
    '广告过滤': ['REJECT', 'DIRECT'],
    '全局直连': ['DIRECT', '⚡️ 自动选择'],
    '全局拦截': ['REJECT', 'DIRECT'],
    '漏网之鱼': ['⚡️ 自动选择', '全局直连', 'DIRECT'],
  };
  const expectedGroupTypes = {
    '⚡️ 自动选择': 'url-test',
    '优先自建': 'fallback',
    '🚇 家宽中转': 'url-test',
  };
  const allGroupMembersExact = groups.every((group) =>
    sameList(
      group.proxies || [],
      expectedGroupProxies[group.name] || []
    )
    && group.type === (expectedGroupTypes[group.name] || 'select')
  );

  if (
    text.includes('fixture-source.invalid')
    || text.includes('/__staging/provider.yaml')
    || text.includes(stagingProviderUrl.toString())
    || document['proxy-providers'] !== undefined
    || !sameSet(proxyNames, expectedNodeNames)
    || !sameCanonicalNodes(proxies, expectedNodes)
    || proxyNames.length !== new Set(proxyNames).size
    || !sameSet(groups.map((group) => group.name), expectedGroupNames)
    || groups.length !== expectedGroupNames.length
    || !allGroupMembersExact
    || !sameList(manual?.proxies || [], expectedManual)
    || !sameList(automatic?.proxies || [], expectedProviderNodeNames)
    || !sameList(relay?.proxies || [], expectedProviderNodeNames)
    || !sameList(
      priority?.proxies || [],
      expectedGroupProxies['优先自建']
    )
    || rules.length !== 116
    || new Set(rules).size !== rules.length
    || rules.at(-1) !== 'MATCH,漏网之鱼'
    || !rules.includes('PROCESS-NAME,Codex,AI')
    || !rules.includes('IP-CIDR,100.64.0.0/10,DIRECT,no-resolve')
    || !sameSet(ruleProviderNames, expectedRuleProviders)
    || dns['enhanced-mode'] !== 'fake-ip'
    || !sameSet(dns.nameserver || [], ['https://dns-fixture.invalid/foreign'])
    || !sameSet(
      dns['proxy-server-nameserver'] || [],
      ['https://dns-fixture.invalid/domestic']
    )
    || !(dns['fake-ip-filter'] || []).includes('+.fixture.invalid')
    || tun.stack !== 'system'
    || tun['strict-route'] !== false
    || !sameSet(tun['route-exclude-address'] || [], [
      '127.0.0.0/8',
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '100.64.0.0/10',
      '203.0.113.0/24',
    ])
    || document.sniffer?.enable !== true
    || document.profile?.['store-selected'] !== true
  ) {
    fail('Materialized 与精确 Staging 基线不一致或泄露上游 URL');
  }

  assertGroupReferences(groups, proxyNames);
  assertRuleTargets(rules, groups);
}

function withPrefix(nodes, prefix) {
  return nodes.map((node) => ({
    ...node,
    name: node.name.startsWith(prefix) ? node.name : `${prefix}${node.name}`,
  }));
}

function sameList(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameSet(left, right) {
  return left.length === right.length
    && [...left].sort().every((value, index) =>
      value === [...right].sort()[index]
    );
}

function sameCanonicalNodes(left, right) {
  return JSON.stringify(canonicalNodes(left))
    === JSON.stringify(canonicalNodes(right));
}

function canonicalNodes(nodes) {
  return nodes
    .map(canonicalValue)
    .sort((left, right) =>
      String(left.name).localeCompare(String(right.name))
    );
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])])
  );
}

async function removePriorSmokeUsers(headers) {
  const users = await adminJson('/api/users', {}, headers, '清理前读取用户');
  for (const user of users) {
    if (user.name !== 'staging-smoke-user' || !user.id) continue;
    await adminJson(
      `/api/users/${encodeURIComponent(user.id)}`,
      { method: 'DELETE' },
      headers,
      '清理旧测试用户'
    );
  }
}

async function adminJson(path, options, headers, label) {
  const requestHeaders = {
    ...headers,
    ...(options.headers || {}),
  };
  let body = options.body;
  if (body && typeof body === 'object') {
    requestHeaders['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await request(path, {
    ...options,
    headers: requestHeaders,
    body,
  });
  expectStatus(response, 200, label);
  return safeJson(response, label);
}

async function signedMirrorRequest(path, upstreamId, body, contentType) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString('base64url');
  const payload = `${timestamp}\n${nonce}\n${upstreamId}\n${body}`;
  const signature = createHmac('sha256', mirrorSecret)
    .update(payload)
    .digest('hex');
  return request(path, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'X-Clash-Timestamp': timestamp,
      'X-Clash-Nonce': nonce,
      'X-Clash-Signature': signature,
    },
    body,
  });
}

async function request(path, options = {}) {
  return fetch(new URL(path, baseUrl), {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
}

async function safeJson(response, label) {
  try {
    return await response.json();
  } catch {
    fail(`${label} 返回的 JSON 无效`);
  }
}

function expectStatus(response, expected, label) {
  if (response.status !== expected) {
    fail(`${label} HTTP ${response.status}，预期 ${expected}`);
  }
}

function assertGroupReferences(groups, proxyNames) {
  const valid = new Set([
    ...proxyNames,
    ...groups.map((group) => group.name),
    'DIRECT',
    'REJECT',
    'REJECT-DROP',
    'PASS',
    'COMPATIBLE',
    'GLOBAL',
  ]);
  for (const group of groups) {
    for (const reference of group.proxies || []) {
      if (!valid.has(reference)) {
        fail('Materialized 存在悬空分组引用');
      }
    }
  }
}

function assertRuleTargets(rules, groups) {
  const validTargets = new Set([
    ...groups.map((group) => group.name),
    'DIRECT',
    'REJECT',
    'REJECT-DROP',
    'PASS',
    'COMPATIBLE',
    'GLOBAL',
  ]);
  for (const rule of rules) {
    const parts = String(rule).split(',');
    const target = parts.at(-1) === 'no-resolve'
      ? parts.at(-2)
      : parts.at(-1);
    if (!target || !validTargets.has(target)) {
      fail('Materialized 存在无效规则目标');
    }
  }
}

async function validateWithMihomo(binary, yaml) {
  if (!isAbsolute(binary)) fail('MIHOMO_BIN 必须是绝对路径');
  const versionResult = await captureProcess(binary, ['-v'], 10_000);
  const version = `${versionResult.output}`
    .trim()
    .split('\n')[0]
    .slice(0, 160);
  if (
    versionResult.code !== 0
    || versionResult.signal === 'SIGKILL'
    || !/^Mihomo Meta v[0-9]/i.test(version)
  ) {
    fail('MIHOMO_BIN 不是可验证的 Mihomo 内核');
  }
  const checkDirectory = await mkdtemp(
    resolve(tmpdir(), 'clash-sub-hub-mihomo-')
  );
  const configPath = resolve(checkDirectory, 'config.yaml');
  await writeFile(configPath, yaml, { encoding: 'utf8', mode: 0o600 });
  try {
    const result = await captureProcess(
      binary,
      ['-t', '-d', checkDirectory, '-f', configPath],
      60_000
    );
    if (result.signal === 'SIGKILL') {
      fail('Mihomo 配置校验超过 60 秒');
    }
    if (result.code !== 0) {
      fail(
        `Mihomo 配置校验失败，退出码 ${result.code}：`
        + sanitizeMihomoOutput(result.output, checkDirectory)
      );
    }
    return { ok: true, version };
  } finally {
    await rm(checkDirectory, { recursive: true, force: true });
  }
}

function captureProcess(binary, args, timeoutMilliseconds) {
  return new Promise((resolveExit) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let output = '';
    const append = (chunk) => {
      if (output.length < 32_000) output += chunk.toString();
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveExit({ ...result, output });
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timeout = setTimeout(
      () => child.kill('SIGKILL'),
      timeoutMilliseconds
    );
    child.once('error', () => finish({ code: -1, signal: null }));
    child.once('exit', (code, signal) => finish({ code, signal }));
  });
}

function sanitizeMihomoOutput(output, checkDirectory) {
  return output
    .replaceAll(checkDirectory, '<TEMP>')
    .replace(/https?:\/\/[^\s"']+/gi, '<URL>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<IP>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<UUID>')
    .replace(/[A-Za-z0-9_-]{40,}/g, '<REDACTED>')
    .trim()
    .split('\n')
    .slice(-8)
    .join(' | ')
    .slice(0, 1200);
}

function fail(message) {
  console.error(`Staging smoke 失败：${message}`);
  process.exit(1);
}
