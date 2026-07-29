#!/usr/bin/env node
/**
 * Sync the current local Clash Verge Merge and provider caches into a dedicated
 * real-data Staging Worker.
 *
 * Safety properties:
 * - The exact Worker hostname and deploymentEnvironment=staging are required.
 * - Provider URLs, node credentials and admin secrets are never printed or
 *   written to Git-tracked files. The subscription token is written once to an
 *   ignored mode-0600 file under .wrangler for direct handoff to the user.
 * - All providers use signed mirror preloading from the already-working local
 *   caches. Production resources and the Clash Verge client are never changed.
 * - The returned materialized YAML must match the local node objects exactly,
 *   pass Mihomo validation and complete an isolated proxy request.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

class SafeFailure extends Error {}

process.on('uncaughtException', (error) => {
  reportFailure(error);
});
process.on('unhandledRejection', (error) => {
  reportFailure(error);
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clashHome = resolve(
  process.env.CLASH_VERGE_HOME
    || join(
      homedir(),
      'Library',
      'Application Support',
      'io.github.clash-verge-rev.clash-verge-rev'
    )
);
const mergePath = resolve(
  process.env.CLASH_VERGE_MERGE || join(clashHome, 'profiles', 'Merge.yaml')
);
const runtimePath = resolve(
  process.env.CLASH_VERGE_RUNTIME || join(clashHome, 'clash-verge-check.yaml')
);
const mihomoBin = resolve(
  process.env.MIHOMO_BIN
    || '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo'
);
const wranglerBin = resolve(root, 'node_modules', '.bin', 'wrangler');
const wranglerConfig = resolve(root, 'wrangler.real-staging.toml');
const linkOutputPath = resolve(
  root,
  '.wrangler',
  `real-staging-subscription-${Date.now()}-${randomBytes(6).toString('hex')}.txt`
);
const target = new URL(
  process.env.REAL_STAGING_URL
    || 'https://clash-sub-hub-real-staging.guoyingwei6.workers.dev'
);
const expectedHost = 'clash-sub-hub-real-staging.guoyingwei6.workers.dev';

if (
  target.protocol !== 'https:'
  || target.hostname !== expectedHost
  || target.port !== ''
  || target.username !== ''
  || target.password !== ''
  || target.pathname !== '/'
  || target.search !== ''
  || target.hash !== ''
) {
  fail('目标不是仓库登记的专属 real-staging Worker');
}

const [mergeText, runtimeText] = await Promise.all([
  readFile(mergePath, 'utf8'),
  readFile(runtimePath, 'utf8'),
]);
const merge = parseYaml(mergeText) || {};
const runtime = parseYaml(runtimeText) || {};
const prepared = await prepareRealMerge(merge, runtime);
if (process.env.REAL_STAGING_VERIFY_LOCAL === '1') {
  const localYaml = stringifyYaml(prepared.expectedConfig);
  await validateWithMihomo(localYaml);
  const connectivity = await validateConnectivity(prepared.expectedConfig);
  console.log(JSON.stringify({
    ok: true,
    localOnly: true,
    checks: {
      mihomoSyntax: true,
      isolatedProxyRequest: connectivity.proxyRequest,
      controllerDelay: connectivity.controllerDelay,
      healthyNodes: connectivity.healthyNodes,
    },
  }, null, 2));
  process.exit(0);
}
if (process.env.REAL_STAGING_PREPARE_ONLY === '1') {
  console.log(JSON.stringify({
    ok: true,
    prepareOnly: true,
    counts: {
      upstreams: prepared.upstreams.length,
      customNodes: prepared.customNodes.length,
      materializedNodes: prepared.materializedNodes.length,
    },
  }, null, 2));
  process.exit(0);
}

await withSyncLock(async () => {
  const adminPassword = randomBytes(48).toString('base64url');
  const mirrorSecret = randomBytes(48).toString('base64url');

  await waitForWorker();
  await setWorkerSecrets({
    ADMIN_PASSWORD: adminPassword,
    MIRROR_UPLOAD_SECRET: mirrorSecret,
  });
  await waitForWorker();

  const login = await createAdminSessionWithRetry(adminPassword);
  const loginPayload = await safeJson(login, '管理会话');
  if (loginPayload.deploymentEnvironment !== 'staging') {
    fail('远端没有确认 deploymentEnvironment=staging');
  }
  const setCookie = login.headers.get('set-cookie') || '';
  if (
    !setCookie.includes('HttpOnly')
    || !setCookie.includes('Secure')
    || !setCookie.includes('SameSite=Strict')
  ) {
    fail('管理会话 Cookie 缺少安全属性');
  }
  const sessionHeaders = { Cookie: setCookie.split(';', 1)[0] };
  await revokePriorRealStagingUsers(sessionHeaders);

  for (const item of prepared.upstreams) {
    await stageMirror(item.upstream, item.content, mirrorSecret);
  }

  const preview = await adminJson(
    '/api/import/merge',
    {
      method: 'POST',
      body: {
        yaml: prepared.mergeYaml,
        action: 'preview',
      },
    },
    sessionHeaders,
    'Merge 预览'
  );
  if (
    preview.ok !== true
    || preview.action !== 'preview'
    || preview.counts?.upstreams !== prepared.upstreams.length
    || preview.counts?.customNodes !== prepared.customNodes.length
  ) {
    fail('Merge 预览与本地真实配置计数不一致');
  }

  const applied = await adminJson(
    '/api/import/merge',
    {
      method: 'POST',
      body: {
        yaml: prepared.mergeYaml,
        action: 'apply',
        strategy: 'replace',
        baseRevision: preview.baseRevision,
      },
    },
    sessionHeaders,
    'Merge 全量替换'
  );
  if (
    applied.ok !== true
    || applied.action !== 'apply'
    || typeof applied.changed !== 'boolean'
    || applied.artifact?.ok !== true
    || (applied.cacheWarnings || []).length !== 0
  ) {
    fail('远端未生成完整真实 Materialized artifact');
  }

  const userName = `real-staging-${new Date().toISOString().slice(0, 10)}`;
  const created = await adminJson(
    '/api/users',
    { method: 'POST', body: { name: userName } },
    sessionHeaders,
    '创建真实测试用户'
  );
  if (typeof created.token !== 'string' || created.token.length < 32) {
    fail('测试订阅 token 未安全生成');
  }
  const subscriptionUrl = new URL(
    `/sub/${encodeURIComponent(created.token)}`,
    target
  );
  let artifact = await fetchSubscriptionArtifact(subscriptionUrl);
  let verification = verifyRemoteConfig(
    artifact.text,
    artifact.document,
    prepared
  );
  let refreshPerformed = false;

  if (!artifact.hit || !verification.ok) {
    if (applied.changed) {
      fail('刚发布的真实 artifact 与本地运行时不等效');
    }
    const refreshed = await adminJson(
      '/api/refresh',
      { method: 'POST' },
      sessionHeaders,
      '重建真实 Materialized artifact'
    );
    if (
      refreshed.ok !== true
      || refreshed.attempted !== 0
      || refreshed.failed !== 0
      || refreshed.artifactReady !== true
    ) {
      fail('Mirror 缓存更新后未重建完整 artifact');
    }
    refreshPerformed = true;
    artifact = await fetchSubscriptionArtifact(subscriptionUrl);
    verification = verifyRemoteConfig(
      artifact.text,
      artifact.document,
      prepared
    );
  }
  if (!artifact.hit) {
    fail('真实测试订阅没有命中已发布 artifact');
  }
  assertRemoteVerification(verification);

  const remoteText = artifact.text;
  const remote = artifact.document;
  await validateWithMihomo(remoteText);
  const connectivity = await validateConnectivity(remote);

  await mkdir(dirname(linkOutputPath), { recursive: true, mode: 0o700 });
  await writeFile(linkOutputPath, `${subscriptionUrl.toString()}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(linkOutputPath, 0o600);

  await request('/api/admin/session', {
    method: 'DELETE',
    headers: sessionHeaders,
  });

  console.log(JSON.stringify({
    ok: true,
    target: expectedHost,
    outputFile: linkOutputPath,
    counts: {
      upstreams: prepared.upstreams.length,
      customNodes: prepared.customNodes.length,
      materializedNodes: prepared.materializedNodes.length,
      groups: Array.isArray(remote['proxy-groups'])
        ? remote['proxy-groups'].length
        : 0,
      rules: Array.isArray(remote.rules) ? remote.rules.length : 0,
    },
    checks: {
      noFixtureData: verification.noFixtureData,
      exactNodeObjects: verification.exactNodeObjects,
      groupShapeMatches: verification.groupShapeMatches,
      rulesMatch: verification.rulesMatch,
      dnsMatches: verification.dnsMatches,
      tunMatches: verification.tunMatches,
      ruleProvidersMatch: verification.ruleProvidersMatch,
      noDanglingReferences: verification.noDanglingReferences,
      sourceUrlsRemoved: verification.sourceUrlsRemoved,
      fullConfigExact: verification.fullConfigExact,
      artifactHit: artifact.hit,
      refreshPerformed,
      mihomoSyntax: true,
      isolatedProxyRequest: connectivity.proxyRequest,
      controllerDelay: connectivity.controllerDelay,
      healthyNodes: connectivity.healthyNodes,
    },
  }, null, 2));
});

async function prepareRealMerge(mergeDocument, runtimeDocument) {
  const rawProviders = mergeDocument['proxy-providers'];
  if (!isRecord(rawProviders) || Object.keys(rawProviders).length === 0) {
    fail('本地 Merge 没有 Provider');
  }
  const rawCustomNodes = Array.isArray(mergeDocument.proxies)
    ? mergeDocument.proxies
    : [];
  const customNodes = rawCustomNodes.filter(isProxyNode);
  if (customNodes.length !== rawCustomNodes.length || customNodes.length === 0) {
    fail('本地自建节点结构无效');
  }

  const providers = {};
  const upstreams = [];
  const providerNodes = [];
  for (const [name, raw] of Object.entries(rawProviders)) {
    if (!isRecord(raw) || raw.type !== 'http' || typeof raw.url !== 'string') {
      fail('本地 Provider 结构无效');
    }
    const id = upstreamIdForName(name);
    const relativePath = typeof raw.path === 'string'
      ? raw.path.replace(/^\.\//, '')
      : join('providers', `${name}.yaml`);
    const cachePath = resolve(clashHome, relativePath);
    if (!isWithin(cachePath, clashHome)) fail('Provider 缓存路径越界');
    const content = await readFile(cachePath, 'utf8');
    const cacheDocument = parseYaml(content) || {};
    const rawNodes = Array.isArray(cacheDocument.proxies)
      ? cacheDocument.proxies
      : [];
    if (rawNodes.length === 0 || rawNodes.some((node) => !isProxyNode(node))) {
      fail('Provider 缓存为空或包含无效节点');
    }

    const userAgent = providerUserAgent(raw);
    const prefix = typeof raw.override?.['additional-prefix'] === 'string'
      ? raw.override['additional-prefix']
      : `${name} | `;
    const exclude = typeof raw['exclude-filter'] === 'string'
      ? raw['exclude-filter']
      : undefined;
    const providerOptions = { ...raw };
    delete providerOptions.url;
    delete providerOptions.header;
    delete providerOptions.override;
    delete providerOptions['exclude-filter'];
    delete providerOptions['x-clash-sub-hub-fetch-mode'];
    delete providerOptions['x-clash-sub-hub-id'];
    delete providerOptions['x-clash-sub-hub-required'];
    const upstream = {
      id,
      name,
      url: raw.url,
      userAgent,
      prefix,
      ...(exclude ? { exclude } : {}),
      fetchMode: 'mirror',
      required: true,
      providerOptions,
    };
    upstreams.push({ upstream, content });

    let nodes = rawNodes.filter((node) => !isInfoNode(node.name));
    if (exclude) {
      let expression;
      try {
        expression = new RegExp(exclude);
      } catch {
        fail('Provider exclude-filter 无效');
      }
      nodes = nodes.filter((node) => !expression.test(node.name));
    }
    providerNodes.push(...nodes.map((node) => ({
      ...node,
      name: prefix && !node.name.startsWith(prefix)
        ? `${prefix}${node.name}`
        : node.name,
    })));

    providers[name] = {
      ...raw,
      override: { 'additional-prefix': prefix },
      'x-clash-sub-hub-id': id,
      'x-clash-sub-hub-fetch-mode': 'mirror',
      'x-clash-sub-hub-required': true,
    };
  }

  const customNames = new Set(customNodes.map((node) => node.name));
  const materializedNodes = deduplicateByName([
    ...providerNodes.filter((node) => !customNames.has(node.name)),
    ...customNodes,
  ]);
  const runtimeCollection = collectRuntimeNodes(runtimeDocument, clashHome);
  if (
    stableJson(canonicalNodes(materializedNodes))
    !== stableJson(canonicalNodes(runtimeCollection))
  ) {
    fail('本地 Merge/缓存与当前运行时节点对象不一致');
  }

  const dns = runtimeDocument.dns || {};
  const tun = runtimeDocument.tun || {};
  const document = {
    'proxy-providers': providers,
    proxies: customNodes,
    'x-clash-sub-hub': {
      'schema-version': 2,
      policy: {
        'filter-upstream-info-nodes': true,
        'missing-cache': 'serve-stale',
        'max-cache-age-seconds': 7 * 24 * 60 * 60,
        'domestic-nameservers': [...(dns['proxy-server-nameserver'] || [])],
        'foreign-nameservers': [...(dns.nameserver || [])],
        'tun-route-exclude-addresses': [...(tun['route-exclude-address'] || [])],
        'dns-fake-ip-filter-append': [...(dns['fake-ip-filter'] || [])],
      },
    },
  };
  const expectedConfig = await buildExpectedConfig(
    materializedNodes,
    customNodes,
    runtimeDocument
  );
  assertLocalRuntimeEquivalent(
    expectedConfig,
    runtimeDocument,
    materializedNodes,
    customNodes.map((node) => node.name)
  );
  return {
    mergeYaml: stringifyYaml(document),
    upstreams,
    customNodes,
    materializedNodes,
    expectedConfig,
  };
}

function assertLocalRuntimeEquivalent(
  expected,
  runtimeDocument,
  materializedNodes,
  customNodeNames
) {
  const expectedGroups = Array.isArray(expected['proxy-groups'])
    ? expected['proxy-groups']
    : [];
  const runtimeGroups = Array.isArray(runtimeDocument['proxy-groups'])
    ? structuredClone(runtimeDocument['proxy-groups'])
    : [];
  const normalizedRuntime = { 'proxy-groups': runtimeGroups };
  injectExpectedNodes(normalizedRuntime, materializedNodes, customNodeNames);
  const normalizedRuntimeGroups = normalizedRuntime['proxy-groups'];
  const expectedRules = Array.isArray(expected.rules) ? expected.rules : [];
  const runtimeRules = Array.isArray(runtimeDocument.rules)
    ? [...new Set(runtimeDocument.rules)]
    : [];
  const checks = [
    stableJson(canonicalValue(expectedGroups))
      === stableJson(canonicalValue(normalizedRuntimeGroups)),
    stableJson(expectedRules) === stableJson(runtimeRules),
    stableJson(canonicalValue(expected['rule-providers'] || {}))
      === stableJson(canonicalValue(runtimeDocument['rule-providers'] || {})),
    expected.dns?.['enhanced-mode'] === runtimeDocument.dns?.['enhanced-mode'],
    expected.tun?.stack === runtimeDocument.tun?.stack,
    expected.tun?.['strict-route'] === runtimeDocument.tun?.['strict-route'],
    expected.sniffer?.enable === runtimeDocument.sniffer?.enable,
    expected.profile?.['store-selected']
      === runtimeDocument.profile?.['store-selected'],
    countDanglingGroupReferences(expectedGroups, materializedNodes) === 0,
    countInvalidRuleTargets(expectedRules, expectedGroups) === 0,
  ];
  if (checks.some((value) => !value)) {
    fail('仓库候选脚本与当前本地运行时不等效');
  }
}

async function buildExpectedConfig(materializedNodes, customNodes, runtimeDocument) {
  const scriptSource = await readFile(
    resolve(root, 'ClashVerge-AI-Academic-Enhanced.js'),
    'utf8'
  );
  const { main } = await import(
    `data:text/javascript;base64,${Buffer.from(scriptSource).toString('base64')}`
  );
  let config = main({
    proxies: structuredClone(materializedNodes),
    'proxy-groups': [],
    'proxy-providers': {},
    'rule-providers': {},
    rules: [],
  });
  if (!isRecord(config)) fail('本地候选脚本返回无效配置');

  const dns = config.dns || {};
  const runtimeDns = runtimeDocument.dns || {};
  const nameserverPolicy = dns['nameserver-policy'] || {};
  const domestic = [...(runtimeDns['proxy-server-nameserver'] || [])];
  const foreign = [...(runtimeDns.nameserver || [])];
  dns['proxy-server-nameserver'] = domestic;
  nameserverPolicy['geosite:private,cn'] = domestic;
  const academicKey = Object.keys(nameserverPolicy)
    .find((key) => key.includes('nature.com'));
  if (academicKey) nameserverPolicy[academicKey] = domestic;
  dns.nameserver = foreign;
  for (const key of Object.keys(nameserverPolicy)) {
    if (key.startsWith('geosite:') && key !== 'geosite:private,cn') {
      nameserverPolicy[key] = foreign;
    }
    if (key.includes('claude.ai')) nameserverPolicy[key] = foreign;
  }
  dns['fake-ip-filter'] = [
    ...new Set([
      ...(dns['fake-ip-filter'] || []),
      ...(runtimeDns['fake-ip-filter'] || []),
    ]),
  ];

  const tun = config.tun || {};
  const runtimeTun = runtimeDocument.tun || {};
  tun['route-exclude-address'] = [
    ...new Set([
      ...(tun['route-exclude-address'] || []),
      ...(runtimeTun['route-exclude-address'] || []),
    ]),
  ];
  config.dns = dns;
  config.tun = tun;
  injectExpectedNodes(
    config,
    materializedNodes,
    customNodes.map((node) => node.name)
  );
  delete config['proxy-providers'];
  return config;
}

function injectExpectedNodes(config, materializedNodes, customNodeNames) {
  const allNames = materializedNodes.map((node) => node.name);
  const customNames = new Set(customNodeNames);
  const providerNames = allNames.filter((name) => !customNames.has(name));
  const groups = Array.isArray(config['proxy-groups'])
    ? config['proxy-groups']
    : [];
  for (const group of groups) {
    const manual = group.name === '节点选择';
    if (!manual && !('use' in group)) continue;
    let names = manual ? allNames : providerNames;
    if (!manual && group.filter) {
      try {
        const expression = new RegExp(group.filter);
        names = names.filter((name) => expression.test(name));
      } catch {
        names = [];
      }
    }
    group.proxies = [...new Set([...(group.proxies || []), ...names])];
    delete group.use;
    delete group.filter;
  }
}

function collectRuntimeNodes(document, baseDirectory) {
  const providers = document['proxy-providers'] || {};
  const customNodes = Array.isArray(document.proxies)
    ? document.proxies.filter(isProxyNode)
    : [];
  const providerNodes = [];
  for (const [name, provider] of Object.entries(providers)) {
    const relativePath = typeof provider.path === 'string'
      ? provider.path.replace(/^\.\//, '')
      : join('providers', `${name}.yaml`);
    const cachePath = resolve(baseDirectory, relativePath);
    if (!isWithin(cachePath, baseDirectory)) fail('运行时缓存路径越界');
    const raw = readFileSyncSafe(cachePath);
    const parsed = parseYaml(raw) || {};
    let nodes = Array.isArray(parsed.proxies)
      ? parsed.proxies.filter(isProxyNode)
      : [];
    nodes = nodes.filter((node) => !isInfoNode(node.name));
    if (provider['exclude-filter']) {
      const expression = new RegExp(provider['exclude-filter']);
      nodes = nodes.filter((node) => !expression.test(node.name));
    }
    const prefix = provider.override?.['additional-prefix'] || '';
    providerNodes.push(...nodes.map((node) => ({
      ...node,
      name: prefix && !node.name.startsWith(prefix)
        ? `${prefix}${node.name}`
        : node.name,
    })));
  }
  const customNames = new Set(customNodes.map((node) => node.name));
  return deduplicateByName([
    ...providerNodes.filter((node) => !customNames.has(node.name)),
    ...customNodes,
  ]);
}

function readFileSyncSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    fail('无法读取运行时 Provider 缓存');
  }
}

async function withSyncLock(action) {
  const lockDirectory = resolve(root, '.wrangler');
  const lockPath = resolve(lockDirectory, 'real-staging-sync.lock');
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let owner = 0;
    try {
      owner = Number((await readFile(lockPath, 'utf8')).trim());
    } catch {
      // An unreadable lock is treated as active.
    }
    let active = owner > 0;
    if (active) {
      try {
        process.kill(owner, 0);
      } catch (probeError) {
        active = probeError?.code !== 'ESRCH';
      }
    }
    if (active) fail('已有 real-staging 同步正在运行');
    await rm(lockPath, { force: true });
    handle = await open(lockPath, 'wx', 0o600);
  }
  await handle.writeFile(`${process.pid}\n`, { encoding: 'utf8' });
  try {
    return await action();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true });
  }
}

async function setWorkerSecrets(secrets) {
  const result = await captureProcess(
    wranglerBin,
    ['secret', 'bulk', '--config', wranglerConfig],
    `${JSON.stringify(secrets)}\n`,
    60_000,
    {
      ...process.env,
      WRANGLER_LOG_PATH: resolve(root, '.wrangler', 'logs'),
    }
  );
  if (result.code !== 0 || result.signal === 'SIGKILL') {
    fail('无法原子更新 real-staging 密钥（内容未输出）');
  }
}

async function revokePriorRealStagingUsers(sessionHeaders) {
  const users = await adminJson(
    '/api/users',
    {},
    sessionHeaders,
    '读取既有测试用户'
  );
  if (!Array.isArray(users)) fail('既有测试用户列表结构无效');
  const unexpected = users.some(
    (user) => typeof user.name !== 'string'
      || !user.name.startsWith('real-staging-')
      || typeof user.id !== 'string'
  );
  if (unexpected) {
    fail('专属 real-staging KV 存在非本流程用户，已停止');
  }
  for (const user of users) {
    await adminJson(
      `/api/users/${encodeURIComponent(user.id)}`,
      { method: 'DELETE' },
      sessionHeaders,
      '吊销旧测试用户'
    );
  }
}

async function waitForWorker() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const response = await fetch(new URL('/admin', target), {
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok) return;
    } catch {
      // Deployment propagation can take a few seconds.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  }
  fail('real-staging Worker 未就绪');
}

async function createAdminSessionWithRetry(password) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const response = await request('/api/admin/session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${password}` },
    });
    if (response.status === 200) return response;
    if (![401, 404, 503].includes(response.status)) {
      expectStatus(response, 200, '管理会话');
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  }
  fail('管理密钥部署后仍未传播');
}

async function stageMirror(upstream, content, secret) {
  const body = JSON.stringify({ upstream, content });
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(18).toString('base64url');
    const payload = `${timestamp}\n${nonce}\n${upstream.id}\n${body}`;
    const signature = createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    const response = await request(
      `/mirror-stage/${encodeURIComponent(upstream.id)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Clash-Timestamp': timestamp,
          'X-Clash-Nonce': nonce,
          'X-Clash-Signature': signature,
        },
        body,
      }
    );
    if (response.status === 200) {
      const result = await safeJson(response, 'Mirror 预载');
      if (result.ok !== true || result.staged !== true) {
        fail('Mirror 预载未确认');
      }
      return;
    }
    if (![401, 404, 503].includes(response.status)) {
      expectStatus(response, 200, 'Mirror 预载');
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  }
  fail('Mirror 密钥部署后仍未传播');
}

function verifyRemoteConfig(text, remote, prepared) {
  const expected = prepared.expectedConfig;
  const remoteNodes = Array.isArray(remote.proxies) ? remote.proxies : [];
  const remoteGroups = Array.isArray(remote['proxy-groups'])
    ? remote['proxy-groups']
    : [];
  const expectedGroups = Array.isArray(expected['proxy-groups'])
    ? expected['proxy-groups']
    : [];
  const remoteRules = Array.isArray(remote.rules) ? remote.rules : [];
  const expectedRules = Array.isArray(expected.rules)
    ? expected.rules
    : [];
  const noFixtureData = !/fixture|192\.0\.2\.|198\.51\.100\.|203\.0\.113\./i.test(text);
  const exactNodeObjects = stableJson(canonicalNodes(remoteNodes))
    === stableJson(canonicalNodes(prepared.materializedNodes));
  const groupShapeMatches = stableJson(canonicalValue(remoteGroups))
    === stableJson(canonicalValue(expectedGroups));
  const rulesMatch = stableJson(remoteRules) === stableJson(expectedRules);
  const dnsMatches = stableJson(canonicalValue(remote.dns || {}))
    === stableJson(canonicalValue(expected.dns || {}));
  const tunMatches = stableJson(canonicalValue(remote.tun || {}))
    === stableJson(canonicalValue(expected.tun || {}));
  const ruleProvidersMatch = stableJson(
    canonicalValue(remote['rule-providers'] || {})
  ) === stableJson(canonicalValue(expected['rule-providers'] || {}));
  const noDanglingReferences =
    countDanglingGroupReferences(remoteGroups, remoteNodes) === 0
    && countInvalidRuleTargets(remoteRules, remoteGroups) === 0;
  const sourceUrlsRemoved = prepared.upstreams.every(
    ({ upstream }) => !text.includes(upstream.url)
  );
  const fullConfigExact = stableJson(canonicalValue(remote))
    === stableJson(canonicalValue(expected));
  const providersRemoved = remote['proxy-providers'] === undefined;
  const ok = noFixtureData
    && exactNodeObjects
    && groupShapeMatches
    && rulesMatch
    && dnsMatches
    && tunMatches
    && ruleProvidersMatch
    && noDanglingReferences
    && sourceUrlsRemoved
    && fullConfigExact
    && providersRemoved;
  return {
    ok,
    noFixtureData,
    exactNodeObjects,
    groupShapeMatches,
    rulesMatch,
    dnsMatches,
    tunMatches,
    ruleProvidersMatch,
    noDanglingReferences,
    sourceUrlsRemoved,
    fullConfigExact,
    providersRemoved,
  };
}

function assertRemoteVerification(verification) {
  if (!verification.ok) {
    fail('远端真实订阅与本地运行时不等效');
  }
}

function countDanglingGroupReferences(groups, nodes) {
  const valid = new Set([
    ...nodes.map((node) => node.name),
    ...groups.map((group) => group.name),
    'DIRECT',
    'REJECT',
    'REJECT-DROP',
    'PASS',
    'COMPATIBLE',
    'GLOBAL',
  ]);
  return groups.reduce(
    (count, group) => count + (group.proxies || [])
      .filter((name) => !valid.has(name)).length,
    0
  );
}

function countInvalidRuleTargets(rules, groups) {
  const valid = new Set([
    ...groups.map((group) => group.name),
    'DIRECT',
    'REJECT',
    'REJECT-DROP',
    'PASS',
    'COMPATIBLE',
    'GLOBAL',
  ]);
  let invalid = 0;
  for (const rule of rules) {
    const parts = String(rule).split(',');
    const target = parts.at(-1) === 'no-resolve'
      ? parts.at(-2)
      : parts.at(-1);
    if (!target || !valid.has(target)) invalid += 1;
  }
  return invalid;
}

async function validateWithMihomo(yaml) {
  const checkDirectory = await prepareMihomoDirectory('syntax');
  const configPath = resolve(checkDirectory, 'config.yaml');
  try {
    await writeFile(configPath, yaml, { encoding: 'utf8', mode: 0o600 });
    const result = await captureProcess(
      mihomoBin,
      ['-t', '-d', checkDirectory, '-f', configPath],
      '',
      60_000
    );
    if (result.code !== 0 || result.signal === 'SIGKILL') {
      fail('真实远端配置未通过 Mihomo 语法校验');
    }
  } finally {
    await rm(checkDirectory, { recursive: true, force: true });
  }
}

async function validateConnectivity(remoteDocument) {
  const checkDirectory = await prepareMihomoDirectory('connectivity');
  let child;
  try {
    const [controllerPort, mixedPort, dnsPort] = await getDistinctFreePorts(3);
    const controllerSecret = randomBytes(24).toString('base64url');
    const config = structuredClone(remoteDocument);
    config.tun = { ...(config.tun || {}), enable: false };
    config.mode = 'global';
    config.dns = {
      ...(config.dns || {}),
      listen: `127.0.0.1:${dnsPort}`,
    };
    config['mixed-port'] = mixedPort;
    config['external-controller'] = `127.0.0.1:${controllerPort}`;
    delete config['external-controller-unix'];
    delete config['external-controller-pipe'];
    config.secret = controllerSecret;
    config['allow-lan'] = false;
    delete config.port;
    delete config['socks-port'];
    delete config['redir-port'];
    delete config['tproxy-port'];
    delete config.listeners;
    delete config['external-ui'];
    delete config['external-ui-url'];
    const configPath = resolve(checkDirectory, 'config.yaml');
    await writeFile(configPath, stringifyYaml(config), {
      encoding: 'utf8',
      mode: 0o600,
    });

    child = spawn(
      mihomoBin,
      ['-d', checkDirectory, '-f', configPath],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    child.stdout.resume();
    child.stderr.resume();
    await waitForController(controllerPort, controllerSecret, child);
    const validationGroup = '⚡️ 自动选择';
    if (
      !(config['proxy-groups'] || [])
        .some((group) => group.name === validationGroup)
    ) {
      fail('隔离连通性验证缺少预期分组');
    }
    const healthyNodes = await warmGroupHealth(
      controllerPort,
      controllerSecret,
      validationGroup
    );
    await selectTemporaryProxy(
      controllerPort,
      controllerSecret,
      'GLOBAL',
      validationGroup
    );
    const delayUrl = new URL(
      `/proxies/${encodeURIComponent(validationGroup)}/delay`,
      `http://127.0.0.1:${controllerPort}`
    );
    delayUrl.searchParams.set('url', 'https://www.gstatic.com/generate_204');
    delayUrl.searchParams.set('timeout', '20000');
    let controllerDelay = false;
    let delayStatus = 0;
    try {
      const delayResponse = await fetch(delayUrl, {
        headers: { Authorization: `Bearer ${controllerSecret}` },
        signal: AbortSignal.timeout(25_000),
      });
      delayStatus = delayResponse.status;
      const delayResult = await delayResponse.json();
      controllerDelay = delayResponse.ok
        && Number.isInteger(delayResult.delay)
        && delayResult.delay > 0;
    } catch {
      controllerDelay = false;
    }

    const curl = await captureProcess(
      '/usr/bin/curl',
      [
        '--proxy',
        `http://127.0.0.1:${mixedPort}`,
        '--silent',
        '--show-error',
        '--output',
        '/dev/null',
        '--write-out',
        '%{http_code}',
        '--max-time',
        '25',
        'https://www.gstatic.com/generate_204',
      ],
      '',
      30_000
    );
    const proxyRequest = curl.code === 0 && curl.output.trim() === '204';
    if (!controllerDelay && !proxyRequest) {
      fail(
        `隔离连通性验证失败：延迟 HTTP ${delayStatus || '超时'}`
        + `，代理进程退出码 ${curl.code}`
      );
    }
    if (!controllerDelay) fail('隔离连通性验证失败：延迟测试未通过');
    if (!proxyRequest) fail('隔离连通性验证失败：代理请求未通过');
    return { controllerDelay, proxyRequest, healthyNodes };
  } finally {
    if (child) {
      child.kill('SIGTERM');
      await new Promise((resolveExit) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          resolveExit();
        }, 3_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolveExit();
        });
      });
    }
    await rm(checkDirectory, { recursive: true, force: true });
  }
}

async function prepareMihomoDirectory(label) {
  const directory = await mkdtemp(
    resolve(tmpdir(), `clash-sub-hub-real-${label}-`)
  );
  for (const name of ['geosite.dat', 'geoip.dat', 'Country.mmdb', 'ASN.mmdb']) {
    try {
      await cp(resolve(clashHome, name), resolve(directory, name));
    } catch {
      // Optional geodata varies by Mihomo build.
    }
  }
  try {
    await cp(
      resolve(clashHome, 'ruleset'),
      resolve(directory, 'ruleset'),
      { recursive: true }
    );
  } catch {
    await rm(directory, { recursive: true, force: true });
    fail('无法准备隔离规则缓存');
  }
  return directory;
}

async function waitForController(port, secret, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      fail('隔离 Mihomo 在控制器启动前退出');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/version`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Controller startup is asynchronous.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  fail('隔离 Mihomo 控制器未启动');
}

async function selectTemporaryProxy(port, secret, group, proxy) {
  const response = await fetch(
    `http://127.0.0.1:${port}/proxies/${encodeURIComponent(group)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: proxy }),
      signal: AbortSignal.timeout(5_000),
    }
  );
  if (![200, 204].includes(response.status)) {
    fail('隔离 Mihomo 无法选择验证分组');
  }
}

async function warmGroupHealth(port, secret, group) {
  const url = new URL(
    `/group/${encodeURIComponent(group)}/delay`,
    `http://127.0.0.1:${port}`
  );
  url.searchParams.set('url', 'https://www.gstatic.com/generate_204');
  url.searchParams.set('timeout', '15000');
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail('隔离 Mihomo 整组健康检查超时');
  }
  if (!response.ok) fail(`隔离 Mihomo 整组健康检查返回 HTTP ${response.status}`);
  let result;
  try {
    result = await response.json();
  } catch {
    fail('隔离 Mihomo 整组健康检查返回结构无效');
  }
  const healthyNodes = Object.values(result || {})
    .filter((delay) => Number.isInteger(delay) && delay > 0)
    .length;
  if (healthyNodes === 0) fail('隔离 Mihomo 整组健康检查没有可用节点');
  return healthyNodes;
}

function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error || !port) rejectPort(error || new Error('端口分配失败'));
        else resolvePort(port);
      });
    });
  });
}

async function getDistinctFreePorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await getFreePort());
  return [...ports];
}

async function adminJson(path, options, sessionHeaders, label) {
  const headers = {
    ...sessionHeaders,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
  };
  const response = await request(path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  expectStatus(response, 200, label);
  return safeJson(response, label);
}

async function fetchSubscriptionArtifact(subscriptionUrl) {
  const response = await fetch(subscriptionUrl, {
    headers: { Accept: 'text/yaml' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail('真实测试订阅无法读取');
  const text = await readTextLimited(response, 20 * 1024 * 1024);
  return {
    hit: response.headers.get('X-Clash-Artifact') === 'hit',
    text,
    document: parseYaml(text) || {},
  };
}

function request(path, options = {}) {
  return fetch(new URL(path, target), {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(90_000),
  });
}

function expectStatus(response, expected, label) {
  if (response.status !== expected) {
    fail(`${label} 返回 HTTP ${response.status}`);
  }
}

async function safeJson(response, label) {
  try {
    return await response.json();
  } catch {
    fail(`${label} 返回结构无效`);
  }
}

async function readTextLimited(response, maximumBytes) {
  const declared = Number(response.headers.get('Content-Length') || 0);
  if (declared > maximumBytes) fail('远端订阅超过安全大小');
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maximumBytes) fail('远端订阅超过安全大小');
  return new TextDecoder().decode(buffer);
}

function captureProcess(binary, args, input, timeoutMilliseconds, env) {
  return new Promise((resolveRun) => {
    const child = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
    });
    let output = '';
    const append = (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-16_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMilliseconds);
    child.once('error', () => {
      clearTimeout(timeout);
      resolveRun({ code: -1, signal: null, output: '' });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolveRun({ code, signal, output });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function upstreamIdForName(name) {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const hashes = seeds.map((seed) => {
    let hash = seed;
    for (const char of name) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 0x01000193);
      hash ^= hash >>> 13;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  });
  return `up_${hashes.join('')}`;
}

function providerUserAgent(provider) {
  const value = provider.header?.['User-Agent'];
  if (Array.isArray(value)) {
    return value.find((item) => typeof item === 'string' && item.trim())
      || 'clash.meta';
  }
  return typeof value === 'string' && value.trim() ? value : 'clash.meta';
}

function canonicalNodes(nodes) {
  return nodes
    .map(canonicalValue)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
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

function groupNameTypes(groups) {
  return groups
    .map((group) => ({ name: group.name, type: group.type }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function deduplicateByName(nodes) {
  const seen = new Set();
  return nodes.filter((node) => {
    if (seen.has(node.name)) return false;
    seen.add(node.name);
    return true;
  });
}

function isInfoNode(name) {
  return /官网|套餐|流量|异常|剩余|ISP|all|免费|低倍率|0\.[0-9]x|测试|到期/i
    .test(name);
}

function isProxyNode(node) {
  return node
    && typeof node === 'object'
    && !Array.isArray(node)
    && typeof node.name === 'string'
    && node.name.trim().length > 0
    && node.name.length <= 512
    && typeof node.type === 'string'
    && node.type.trim().length > 0
    && node.type.length <= 64
    && typeof node.server === 'string'
    && node.server.trim().length > 0
    && node.server.length <= 253
    && typeof node.port === 'number'
    && Number.isInteger(node.port)
    && node.port >= 1
    && node.port <= 65535;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isWithin(path, parent) {
  const relative = path.slice(parent.length);
  return path === parent
    || (
      path.startsWith(parent)
      && (relative.startsWith('/') || relative.startsWith('\\'))
    );
}

function stableJson(value) {
  return JSON.stringify(value);
}

function fail(message) {
  throw new SafeFailure(message);
}

function reportFailure(error) {
  if (error instanceof SafeFailure) {
    console.error(`真实 Staging 同步失败：${error.message}`);
  } else {
    console.error('真实 Staging 同步失败（敏感详情已隐藏）');
  }
  process.exitCode = 1;
}
