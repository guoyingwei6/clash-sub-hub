#!/usr/bin/env node
/**
 * Read-only local equivalence audit.
 *
 * It reads Clash Verge's active Merge, runtime config and provider cache files
 * in memory, but prints only counts and booleans. URLs, tokens, node names,
 * credentials and raw YAML are never printed or written.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const defaultHome = join(
  homedir(),
  'Library',
  'Application Support',
  'io.github.clash-verge-rev.clash-verge-rev'
);
const clashHome = resolve(process.env.CLASH_VERGE_HOME || defaultHome);
const mergePath = resolve(
  process.env.CLASH_VERGE_MERGE || join(clashHome, 'profiles', 'Merge.yaml')
);
const runtimePath = resolve(
  process.env.CLASH_VERGE_RUNTIME || join(clashHome, 'clash-verge-check.yaml')
);
const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'ClashVerge-AI-Academic-Enhanced.js'
);
const defaultMihomoBin =
  '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo';
const mihomoBin = resolve(process.env.MIHOMO_BIN || defaultMihomoBin);

if (!isAbsolute(clashHome) || !isAbsolute(mergePath) || !isAbsolute(runtimePath)) {
  fail('Clash Verge 路径必须是绝对路径');
}

let merge;
let runtime;
let runScript;
try {
  merge = parseYaml(await readFile(mergePath, 'utf8')) || {};
  runtime = parseYaml(await readFile(runtimePath, 'utf8')) || {};
  const scriptSource = await readFile(scriptPath, 'utf8');
  ({ main: runScript } = await import(
    `data:text/javascript;base64,${Buffer.from(scriptSource).toString('base64')}`
  ));
} catch {
  fail('无法读取或解析本地 Clash Verge 配置或候选脚本');
}

const mergeCollection = await collectMaterializedNodes(merge, clashHome);
const runtimeCollection = await collectMaterializedNodes(runtime, clashHome);
const providers = mergeCollection.providers;
const customNodes = mergeCollection.customNodes;
const materializedNodes = mergeCollection.materializedNodes;
const runtimeMaterializedNodes = runtimeCollection.materializedNodes;
const customNames = new Set(customNodes.map((node) => node.name));
const providerMaterializedNames = new Set(
  materializedNodes
    .filter((node) => !customNames.has(node.name))
    .map((node) => node.name)
);

let candidate = runScript({
  proxies: structuredClone(materializedNodes),
  'proxy-groups': [],
  'proxy-providers': structuredClone(providers),
  'rule-providers': {},
  rules: [],
});
const preInjectionGroups = structuredClone(candidate['proxy-groups'] || []);
injectMaterializedNodes(
  candidate,
  [...providerMaterializedNames],
  [...customNames]
);
delete candidate['proxy-providers'];

const runtimeRules = Array.isArray(runtime.rules) ? runtime.rules : [];
const uniqueRuntimeRules = [...new Set(runtimeRules)];
const candidateRules = Array.isArray(candidate.rules) ? candidate.rules : [];
const runtimeGroups = Array.isArray(runtime['proxy-groups'])
  ? runtime['proxy-groups']
  : [];
const candidateGroups = Array.isArray(candidate['proxy-groups'])
  ? candidate['proxy-groups']
  : [];
const manual = candidateGroups.find((group) => group.name === '节点选择');
const automatic = candidateGroups.find((group) => group.name === '⚡️ 自动选择');
const autoBaseline = preInjectionGroups
  .find((group) => group.name === '⚡️ 自动选择');
const eligibleProviderNames = [...providerMaterializedNames].filter((name) => {
  if (!autoBaseline?.filter) return true;
  try {
    return new RegExp(autoBaseline.filter).test(name);
  } catch {
    return false;
  }
});

const runtimeTun = runtime.tun || {};
const candidateTun = candidate.tun || {};
const runtimeDns = runtime.dns || {};
const candidateDns = candidate.dns || {};
const baseTunRoutes = candidateTun['route-exclude-address'] || [];
const baseFakeIpFilter = candidateDns['fake-ip-filter'] || [];
const tuning = {
  tunRouteExcludesRepresentable: isSubset(
    baseTunRoutes,
    runtimeTun['route-exclude-address'] || []
  ),
  dnsFakeIpAppendRepresentable: isSubset(
    baseFakeIpFilter,
    runtimeDns['fake-ip-filter'] || []
  ),
  domesticNameserversRepresentable:
    Array.isArray(runtimeDns['proxy-server-nameserver'])
    && runtimeDns['proxy-server-nameserver'].length > 0,
  foreignNameserversRepresentable:
    Array.isArray(runtimeDns.nameserver)
    && runtimeDns.nameserver.length > 0,
};

candidate.tun['route-exclude-address'] = structuredClone(
  runtimeTun['route-exclude-address'] || []
);
candidate.dns['fake-ip-filter'] = structuredClone(
  runtimeDns['fake-ip-filter'] || []
);
candidate.dns.nameserver = structuredClone(runtimeDns.nameserver || []);
candidate.dns['proxy-server-nameserver'] = structuredClone(
  runtimeDns['proxy-server-nameserver'] || []
);
const mihomoValidated = await validateWithMihomo(candidate, mihomoBin);

const groupNamesAndTypesEqual = stableJson(groupNameTypes(runtimeGroups))
  === stableJson(groupNameTypes(preInjectionGroups));
const uniqueRuleOrderEqual = stableJson(candidateRules)
  === stableJson(uniqueRuntimeRules);
const manualAllNodes = materializedNodes.every(
  (node) => manual?.proxies?.includes(node.name)
);
const automaticProviderOnly = sameSet(
  automatic?.proxies || [],
  eligibleProviderNames
);
const danglingGroupReferences = countDanglingGroupReferences(
  candidateGroups,
  materializedNodes.map((node) => node.name)
);
const sourceUrlsRemoved = !Object.values(providers).some(
  (provider) =>
    typeof provider.url === 'string'
    && JSON.stringify(candidate).includes(provider.url)
);
const materializedNodeObjectsEqual = stableJson(
  canonicalNodes(runtimeMaterializedNodes)
) === stableJson(canonicalNodes(materializedNodes));

const checks = {
  allProviderCachesPresent:
    mergeCollection.missingProviderCaches === 0
    && runtimeCollection.missingProviderCaches === 0,
  providerFiltersValid:
    mergeCollection.invalidProviderFilters === 0
    && runtimeCollection.invalidProviderFilters === 0,
  allNodesSchemaValid:
    mergeCollection.invalidNodes === 0
    && runtimeCollection.invalidNodes === 0,
  providerCountMatches:
    Object.keys(providers).length
    === Object.keys(runtime['proxy-providers'] || {}).length,
  customNodeCountMatches:
    customNodes.length === runtimeCollection.customNodes.length,
  materializedNodeObjectsEqual,
  groupNamesAndTypesEqual,
  uniqueRuleOrderEqual,
  tunStackEqual: candidateTun.stack === runtimeTun.stack,
  tunStrictRouteEqual:
    candidateTun['strict-route'] === runtimeTun['strict-route'],
  dnsEnhancedModeEqual:
    candidateDns['enhanced-mode'] === runtimeDns['enhanced-mode'],
  manualAllNodes,
  automaticProviderOnly,
  noDanglingGroupReferences: danglingGroupReferences === 0,
  sourceUrlsRemoved,
  mihomoValidated,
  ...tuning,
};

const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({
  ok,
  runtime: {
    providers: Object.keys(runtime['proxy-providers'] || {}).length,
    customNodes: runtimeCollection.customNodes.length,
    materializedNodes: runtimeMaterializedNodes.length,
    groups: runtimeGroups.length,
    rules: runtimeRules.length,
    uniqueRules: uniqueRuntimeRules.length,
  },
  candidate: {
    materializedNodes: materializedNodes.length,
    groups: candidateGroups.length,
    rules: candidateRules.length,
    manualSelectableNodes: materializedNodes.filter(
      (node) => manual?.proxies?.includes(node.name)
    ).length,
  },
  normalizations: {
    duplicateRuntimeRulesRemoved:
      runtimeRules.length - uniqueRuntimeRules.length,
    unstableDnsGeositeCategoriesUseDomainPolicies: true,
    providerUrlsRemovedFromMaterializedOutput: sourceUrlsRemoved,
  },
  checks,
}, null, 2));
if (!ok) process.exitCode = 1;

function injectMaterializedNodes(config, providerNames, localNames) {
  const allNames = [
    ...providerNames,
    ...localNames.filter((name) => !providerNames.includes(name)),
  ];
  for (const group of config['proxy-groups'] || []) {
    const manualSelection = group.name === '节点选择';
    if (!manualSelection && !('use' in group)) continue;
    let names = manualSelection ? allNames : providerNames;
    if (!manualSelection && group.filter) {
      try {
        const filter = new RegExp(group.filter);
        names = names.filter((name) => filter.test(name));
      } catch {
        names = [];
      }
    }
    group.proxies = [...new Set([...(group.proxies || []), ...names])];
    delete group.use;
    delete group.filter;
  }
}

async function collectMaterializedNodes(document, baseDirectory) {
  const providers = document['proxy-providers'] || {};
  const rawCustomNodes = Array.isArray(document.proxies)
    ? document.proxies
    : [];
  const customNodes = rawCustomNodes.filter(isProxyNode);
  const providerNodes = [];
  let missingProviderCaches = 0;
  let invalidProviderFilters = 0;
  let invalidNodes = rawCustomNodes.length - customNodes.length;

  for (const [name, provider] of Object.entries(providers)) {
    const relativePath = typeof provider.path === 'string'
      ? provider.path.replace(/^\.\//, '')
      : join('providers', `${name}.yaml`);
    const cachePath = resolve(baseDirectory, relativePath);
    if (!isWithin(cachePath, baseDirectory)) {
      fail('Provider 缓存路径越界');
    }

    let providerDocument;
    try {
      providerDocument = parseYaml(await readFile(cachePath, 'utf8')) || {};
    } catch {
      missingProviderCaches += 1;
      continue;
    }

    const rawNodes = Array.isArray(providerDocument.proxies)
      ? providerDocument.proxies
      : [];
    let nodes = rawNodes.filter(isProxyNode);
    invalidNodes += rawNodes.length - nodes.length;
    nodes = nodes.filter((node) => !isInfoNode(node.name));

    if (provider['exclude-filter']) {
      try {
        const exclude = new RegExp(provider['exclude-filter']);
        nodes = nodes.filter((node) => !exclude.test(node.name));
      } catch {
        invalidProviderFilters += 1;
      }
    }

    const prefix = provider.override?.['additional-prefix'] || '';
    providerNodes.push(
      ...nodes.map((node) => applyProviderPrefix(node, prefix))
    );
  }

  const customNames = new Set(customNodes.map((node) => node.name));
  const trustedProviderNodes = providerNodes.filter(
    (node) => !customNames.has(node.name)
  );
  return {
    providers,
    customNodes,
    materializedNodes: deduplicateByName([
      ...trustedProviderNodes,
      ...customNodes,
    ]),
    missingProviderCaches,
    invalidProviderFilters,
    invalidNodes,
  };
}

function applyProviderPrefix(node, prefix) {
  if (!prefix || node.name.startsWith(prefix)) return { ...node };
  return { ...node, name: `${prefix}${node.name}` };
}

function canonicalNodes(nodes) {
  return nodes
    .map((node) => canonicalValue(node))
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

async function validateWithMihomo(config, binary) {
  if (!isAbsolute(binary)) return false;
  const version = await runMihomo(binary, ['-v']);
  if (
    version.code !== 0
    || !/mihomo\s+meta/i.test(`${version.stdout}\n${version.stderr}`)
  ) {
    return false;
  }

  const checkDirectory = await mkdtemp(
    resolve(tmpdir(), 'clash-sub-hub-local-audit-')
  );
  try {
    const result = await runMihomo(
      binary,
      ['-t', '-d', checkDirectory, '-f', '/dev/stdin'],
      stringifyYaml(config)
    );
    return result.code === 0 && result.signal !== 'SIGKILL';
  } finally {
    await rm(checkDirectory, { recursive: true, force: true });
  }
}

function runMihomo(binary, args, input = '') {
  return new Promise((resolveRun) => {
    const child = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const append = (target, chunk) =>
      `${target}${chunk.toString()}`.slice(-16_000);
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('error', () => {
      clearTimeout(timeout);
      resolveRun({ code: -1, signal: null, stdout: '', stderr: '' });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolveRun({ code, signal, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function groupNameTypes(groups) {
  return groups
    .map((group) => ({ name: group.name, type: group.type }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function countDanglingGroupReferences(groups, proxyNames) {
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
  return groups.reduce(
    (count, group) => count + (group.proxies || [])
      .filter((name) => !valid.has(name)).length,
    0
  );
}

function deduplicateByName(nodes) {
  const seen = new Set();
  return nodes.filter((node) => {
    if (seen.has(node.name)) return false;
    seen.add(node.name);
    return true;
  });
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

function isInfoNode(name) {
  return /官网|套餐|流量|异常|剩余|ISP|all|免费|低倍率|0\.[0-9]x|测试|到期/i
    .test(name);
}

function isWithin(path, parent) {
  const relative = path.slice(parent.length);
  return path === parent
    || (path.startsWith(parent) && (relative.startsWith('/') || relative.startsWith('\\')));
}

function isSubset(left, right) {
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function sameSet(left, right) {
  return left.length === right.length
    && [...left].sort().every((value, index) =>
      value === [...right].sort()[index]
    );
}

function stableJson(value) {
  return JSON.stringify(value);
}

function fail(message) {
  console.error(`本地等效性审计失败：${message}`);
  process.exit(1);
}
