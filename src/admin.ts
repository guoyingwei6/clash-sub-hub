import { Env, Upstream, ProxyNode, GlobalSettings } from './types';
import { testUpstreamUrl, handleScheduled, fetchUpstream } from './cron';
import { getGlobalSettings } from './settings';
import { parseClashYaml, filterNodes, isProxyNode } from './converter';
import { connect } from 'cloudflare:sockets';
import { parseYaml, stringifyYaml } from './yaml';
import { parseRoutingYaml, RoutingValidationError } from './domain/routing-profile';
import {
  DesiredConfigDraft,
  MaterializedArtifact,
  UpstreamDefinition,
} from './domain/config';
import {
  diffDesiredConfig,
  MergeValidationError,
  newUpstreamId,
  serializeMergeConfig,
} from './domain/merge';
import { applyMergeImport, previewMergeImport } from './domain/merge-import';
import {
  ConfigConflictError,
  ConfigStateError,
  loadActiveDesiredConfig,
  publishDesiredConfig,
  toDraft,
} from './storage/config-state';
import { getUpstreamCache, getUpstreamState } from './storage/upstream-cache';
import { cacheAgeSeconds } from './domain/cache-policy';
import {
  MAX_MERGE_BYTES,
  MAX_NODE_YAML_BYTES,
  requestTooLarge,
  utf8ByteLength,
} from './limits';
import { builtinScriptContent } from './generated/script-content';
import { isReservedProxyName } from './domain/reserved-names';
import {
  buildDefaultMaterializedArtifact,
  rebuildDefaultMaterializedArtifact,
} from './subscription';

export async function getConfiguredUpstreams(env: Env): Promise<Upstream[]> {
  const config = await loadActiveDesiredConfig(env.KV);
  return Promise.all(config.upstreams.map(async (definition) => {
    const status = await getUpstreamState(env.KV, definition);
    return {
      id: definition.id,
      name: definition.name,
      url: definition.url,
      userAgent: definition.userAgent,
      exclude: definition.exclude,
      prefix: definition.prefix,
      localFetch: definition.fetchMode === 'mirror',
      lastUpdate: status?.lastSuccessAt ?? null,
      nodeCount: status?.nodeCount ?? 0,
      lastError: status?.lastError ?? null,
      fetchMode: definition.fetchMode,
      required: definition.required,
      lastAttemptAt: status?.lastAttemptAt ?? null,
      lastSuccessAt: status?.lastSuccessAt ?? null,
      cacheUpdatedAt: status?.cacheUpdatedAt ?? null,
      cacheAgeSeconds: status?.cacheUpdatedAt
        ? cacheAgeSeconds(status.cacheUpdatedAt, new Date())
        : null,
      cacheStale: status?.cacheUpdatedAt
        ? cacheAgeSeconds(status.cacheUpdatedAt, new Date()) > config.policy.maxCacheAgeSeconds
        : true,
      consecutiveFailures: status?.consecutiveFailures ?? 0,
      nextRetryAt: status?.nextRetryAt ?? null,
      usage: status?.usage ?? null,
    };
  }));
}

async function mutateDesiredConfig(
  env: Env,
  mutate: (draft: DesiredConfigDraft) => void
): Promise<void> {
  const current = await loadActiveDesiredConfig(env.KV);
  const before = toDraft(current);
  const draft = structuredClone(before);
  mutate(draft);
  const diff = diffDesiredConfig(before, draft);
  const cacheSensitive = diff.upstreams.added.length > 0
    || diff.upstreams.updated.some((item) => item.changedFields.some(
      (field) => ['url', 'userAgent', 'fetchMode', 'required'].includes(field)
    ))
    || diff.policyChangedFields.some(
      (field) => ['missingCache', 'maxCacheAgeSeconds'].includes(field)
  );
  if (cacheSensitive) await prepareConfiguredCaches(draft, env);
  const artifact = diff.hasChanges
    ? await buildDefaultMaterializedArtifact(draft, env)
    : undefined;
  await publishDesiredConfig(
    env.KV,
    draft,
    {
      expectedRevision: current.revision,
      materializedArtifact: artifact,
    }
  );
}

function adminPrefix(value: string | undefined, name: string): string {
  if (value === undefined) return `${name} | `;
  if (!value) return '';
  return value.endsWith(' | ') ? value : `${value} | `;
}

function mutationError(error: unknown): Response {
  if (error instanceof RoutingValidationError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof ConfigConflictError) {
    return Response.json(
      { error: error.message, currentRevision: error.currentRevision },
      { status: 409 }
    );
  }
  if (error instanceof ConfigStateError) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (error instanceof ConfigReadinessError) {
    return Response.json(
      {
        error: error.message,
        code: 'CACHE_NOT_READY',
        upstreams: error.upstreams,
      },
      { status: 409 }
    );
  }
  throw error;
}

class ConfigReadinessError extends Error {
  readonly upstreams: string[];

  constructor(upstreams: string[]) {
    super(`必需上游缓存未就绪: ${upstreams.join('、')}`);
    this.name = 'ConfigReadinessError';
    this.upstreams = upstreams;
  }
}

async function prepareConfiguredCaches(
  desired: DesiredConfigDraft,
  env: Env
): Promise<string[]> {
  const settings = await getGlobalSettings(env);
  const enabled = desired.upstreams.filter(
    (upstream) => upstream.fetchMode !== 'disabled'
  );

  const results = await Promise.all(enabled.map(async (upstream) => {
    if (await cacheIsReady(upstream, desired, env)) {
      return { name: upstream.name, required: upstream.required, ready: true };
    }

    if (upstream.fetchMode === 'server') {
      await fetchUpstream(upstream, settings, env, { force: true });
      if (await cacheIsReady(upstream, desired, env)) {
        return { name: upstream.name, required: upstream.required, ready: true };
      }
    }

    return { name: upstream.name, required: upstream.required, ready: false };
  }));

  const requiredUnready = results
    .filter((result) => !result.ready && result.required)
    .map((result) => result.name);
  if (requiredUnready.length > 0) throw new ConfigReadinessError(requiredUnready);
  return results
    .filter((result) => !result.ready)
    .map((result) => result.name);
}

async function cacheIsReady(
  upstream: UpstreamDefinition,
  desired: DesiredConfigDraft,
  env: Env
): Promise<boolean> {
  const cache = await getUpstreamCache(env.KV, upstream);
  if (!cache) return false;
  if (desired.policy.missingCache === 'serve-stale') return true;
  return cacheAgeSeconds(cache.updatedAt, new Date()) <= desired.policy.maxCacheAgeSeconds;
}

// ==================== 全局设置 API ====================

export async function getSettings(env: Env): Promise<Response> {
  const [settings, config] = await Promise.all([
    getGlobalSettings(env),
    loadActiveDesiredConfig(env.KV),
  ]);
  return Response.json({
    ...settings,
    filterEnabled: config.policy.filterUpstreamInfoNodes,
  });
}

export async function updateSettings(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Partial<GlobalSettings>;
  if (
    body.defaultUA !== undefined
    && (typeof body.defaultUA !== 'string'
      || !body.defaultUA.trim()
      || body.defaultUA.length > 512)
  ) {
    return Response.json({ error: 'defaultUA 无效' }, { status: 400 });
  }
  if (
    body.fetchTimeout !== undefined
    && (!Number.isInteger(body.fetchTimeout)
      || body.fetchTimeout < 1
      || body.fetchTimeout > 60)
  ) {
    return Response.json({ error: 'fetchTimeout 必须是 1 到 60 秒的整数' }, { status: 400 });
  }
  if (body.filterEnabled !== undefined && typeof body.filterEnabled !== 'boolean') {
    return Response.json({ error: 'filterEnabled 必须是布尔值' }, { status: 400 });
  }

  const current = await getGlobalSettings(env);
  if (body.filterEnabled !== undefined) {
    await mutateDesiredConfig(env, (draft) => {
      draft.policy.filterUpstreamInfoNodes = body.filterEnabled!;
    });
    current.filterEnabled = body.filterEnabled;
  }
  if (body.defaultUA !== undefined) current.defaultUA = body.defaultUA.trim();
  if (body.fetchTimeout !== undefined) current.fetchTimeout = body.fetchTimeout;
  await env.KV.put('global-settings', JSON.stringify(current));
  return Response.json({ ok: true });
}

// ==================== 上游订阅管理 ====================

export async function listUpstreams(env: Env): Promise<Response> {
  return Response.json(await getConfiguredUpstreams(env));
}

export async function createUpstream(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { name: string; url: string; userAgent?: string; exclude?: string; prefix?: string };
  if (!body.name || !body.url) {
    return Response.json({ error: 'name 和 url 必填' }, { status: 400 });
  }

  try {
    const parsedUrl = new URL(body.url);
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return Response.json({ error: 'url 仅支持 http/https' }, { status: 400 });
    }
  } catch {
    return Response.json({ error: 'url 无效' }, { status: 400 });
  }

  const settings = await getGlobalSettings(env);
  try {
    await mutateDesiredConfig(env, (draft) => {
      if (draft.upstreams.some((upstream) => upstream.name === body.name)) {
        throw new MergeValidationError('名称已存在');
      }
      const upstream: UpstreamDefinition = {
        id: newUpstreamId(),
        name: body.name,
        url: body.url,
        userAgent: body.userAgent || settings.defaultUA,
        exclude: body.exclude,
        prefix: adminPrefix(body.prefix, body.name),
        fetchMode: 'server',
        required: false,
        providerOptions: { type: 'http', interval: 3600 },
      };
      draft.upstreams.push(upstream);
    });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof MergeValidationError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return mutationError(error);
  }
}

export async function updateUpstream(
  name: string,
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as { url?: string; userAgent?: string; exclude?: string; prefix?: string; localFetch?: boolean };
  if (body.url !== undefined) {
    try {
      const parsedUrl = new URL(body.url);
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        return Response.json({ error: 'url 仅支持 http/https' }, { status: 400 });
      }
    } catch {
      return Response.json({ error: 'url 无效' }, { status: 400 });
    }
  }

  try {
    let found = false;
    await mutateDesiredConfig(env, (draft) => {
      const upstream = draft.upstreams.find((item) => item.name === name);
      if (!upstream) return;
      found = true;
      if (body.url !== undefined) upstream.url = body.url;
      if (body.userAgent !== undefined) upstream.userAgent = body.userAgent;
      if ('exclude' in body) upstream.exclude = body.exclude;
      if ('prefix' in body) upstream.prefix = adminPrefix(body.prefix, upstream.name);
      if ('localFetch' in body) upstream.fetchMode = body.localFetch ? 'mirror' : 'server';
    });
    if (!found) return Response.json({ error: '不存在' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    return mutationError(error);
  }
}

export async function deleteUpstream(name: string, env: Env): Promise<Response> {
  try {
    let found = false;
    await mutateDesiredConfig(env, (draft) => {
      const index = draft.upstreams.findIndex((item) => item.name === name);
      if (index === -1) return;
      found = true;
      draft.upstreams.splice(index, 1);
    });
    if (!found) return Response.json({ error: '不存在' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    return mutationError(error);
  }
}

export async function testUpstream(request: Request): Promise<Response> {
  const body = (await request.json()) as { url: string; userAgent?: string };
  if (!body.url) return Response.json({ error: 'url 必填' }, { status: 400 });

  const result = await testUpstreamUrl(body.url, body.userAgent || 'clash.meta');
  return Response.json(result);
}

export async function testExistingUpstream(name: string, env: Env): Promise<Response> {
  const upstreams = await getConfiguredUpstreams(env);
  const upstream = upstreams.find((u) => u.name === name);
  if (!upstream) return Response.json({ error: '不存在' }, { status: 404 });

  const result = await testUpstreamUrl(upstream.url, upstream.userAgent);
  return Response.json(result);
}

export async function listUpstreamNodes(name: string, env: Env): Promise<Response> {
  const config = await loadActiveDesiredConfig(env.KV);
  const upstream = config.upstreams.find((item) => item.name === name);
  if (!upstream) return Response.json({ error: '不存在' }, { status: 404 });
  const cache = await getUpstreamCache(env.KV, upstream);
  if (!cache) return Response.json({ nodes: [] });

  const nodes = parseClashYaml(cache.content);
  const filtered = filterNodes(nodes);
  return Response.json({
    total: nodes.length,
    filtered: filtered.length,
    nodes: filtered.map((n) => ({ name: n.name, type: n.type, server: n.server, port: n.port })),
  });
}

export async function testUpstreamNode(name: string, request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { nodeName: string };
  if (!body.nodeName) return Response.json({ error: 'nodeName 必填' }, { status: 400 });

  const config = await loadActiveDesiredConfig(env.KV);
  const upstream = config.upstreams.find((item) => item.name === name);
  if (!upstream) return Response.json({ error: '不存在' }, { status: 404 });
  const cache = await getUpstreamCache(env.KV, upstream);
  if (!cache) return Response.json({ error: '无缓存' }, { status: 404 });

  const nodes = parseClashYaml(cache.content);
  const node = nodes.find((n) => n.name === body.nodeName);
  if (!node) return Response.json({ error: '节点不存在' }, { status: 404 });

  const result = await testNodeReachability(node.server, node.port);
  return Response.json(result);
}

export async function refreshOne(name: string, env: Env): Promise<Response> {
  const config = await loadActiveDesiredConfig(env.KV);
  const upstream = config.upstreams.find((item) => item.name === name);
  if (!upstream) return Response.json({ error: '不存在' }, { status: 404 });
  if (upstream.fetchMode !== 'server') {
    return Response.json(
      { error: `该上游使用 ${upstream.fetchMode} 模式，Worker 不执行远端抓取` },
      { status: 400 }
    );
  }

  const settings = await getGlobalSettings(env);
  const updated = await fetchUpstream(upstream, settings, env, { force: true });

  if (updated.lastError) {
    return Response.json({ ok: false, error: updated.lastError });
  }
  const artifact = await rebuildDefaultMaterializedArtifact(env);
  if (!artifact.ok) {
    return Response.json(
      {
        ok: false,
        cacheUpdated: true,
        nodeCount: updated.nodeCount,
        artifactReady: false,
        error: artifact.error,
      },
      { status: 503 }
    );
  }
  return Response.json({
    ok: true,
    nodeCount: updated.nodeCount,
    artifactReady: true,
    revision: artifact.revision,
  });
}

export async function refreshAll(env: Env): Promise<Response> {
  const summary = await handleScheduled(env, { force: true });
  return Response.json({
    ok: summary.failed === 0 && summary.artifactReady,
    ...summary,
  });
}

// ==================== 自建节点管理 ====================

export async function listCustomNodes(env: Env): Promise<Response> {
  const config = await loadActiveDesiredConfig(env.KV);
  return Response.json(config.customNodes);
}

export async function createCustomNode(request: Request, env: Env): Promise<Response> {
  if (requestTooLarge(request, MAX_NODE_YAML_BYTES)) {
    return Response.json({ error: '节点 YAML 过大' }, { status: 413 });
  }
  const body = (await request.json()) as { yaml: string };
  if (!body.yaml) return Response.json({ error: 'yaml 必填' }, { status: 400 });
  if (utf8ByteLength(body.yaml) > MAX_NODE_YAML_BYTES) {
    return Response.json({ error: '节点 YAML 过大' }, { status: 413 });
  }

  let node: ProxyNode;
  try {
    node = parseYaml<ProxyNode>(body.yaml);
    if (!isProxyNode(node)) {
      return Response.json({ error: '节点缺少必要字段 (name, type, server, port)' }, { status: 400 });
    }
    if (isReservedProxyName(node.name)) {
      return Response.json({ error: '节点名称与内置分组冲突' }, { status: 400 });
    }
  } catch {
    return Response.json({ error: 'YAML 解析失败' }, { status: 400 });
  }

  try {
    await mutateDesiredConfig(env, (draft) => {
      if (draft.customNodes.some((item) => item.name === node.name)) {
        throw new MergeValidationError('节点名已存在');
      }
      draft.customNodes.push(node);
    });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof MergeValidationError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return mutationError(error);
  }
}

export async function updateCustomNode(
  name: string,
  request: Request,
  env: Env
): Promise<Response> {
  if (requestTooLarge(request, MAX_NODE_YAML_BYTES)) {
    return Response.json({ error: '节点 YAML 过大' }, { status: 413 });
  }
  const body = (await request.json()) as { yaml: string };
  if (!body.yaml) return Response.json({ error: 'yaml 必填' }, { status: 400 });
  if (utf8ByteLength(body.yaml) > MAX_NODE_YAML_BYTES) {
    return Response.json({ error: '节点 YAML 过大' }, { status: 413 });
  }

  let node: ProxyNode;
  try {
    node = parseYaml<ProxyNode>(body.yaml);
    if (!isProxyNode(node)) {
      return Response.json({ error: '节点缺少必要字段' }, { status: 400 });
    }
    if (isReservedProxyName(node.name)) {
      return Response.json({ error: '节点名称与内置分组冲突' }, { status: 400 });
    }
  } catch {
    return Response.json({ error: 'YAML 解析失败' }, { status: 400 });
  }

  try {
    let found = false;
    await mutateDesiredConfig(env, (draft) => {
      const index = draft.customNodes.findIndex((item) => item.name === name);
      if (index === -1) return;
      found = true;
      if (
        node.name !== name
        && draft.customNodes.some((item, otherIndex) => otherIndex !== index && item.name === node.name)
      ) {
        throw new MergeValidationError('节点名已存在');
      }
      draft.customNodes[index] = node;
    });
    if (!found) return Response.json({ error: '不存在' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof MergeValidationError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return mutationError(error);
  }
}

export async function deleteCustomNode(name: string, env: Env): Promise<Response> {
  try {
    let found = false;
    await mutateDesiredConfig(env, (draft) => {
      const index = draft.customNodes.findIndex((item) => item.name === name);
      if (index === -1) return;
      found = true;
      draft.customNodes.splice(index, 1);
    });
    if (!found) return Response.json({ error: '不存在' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    return mutationError(error);
  }
}

// ==================== 自建节点测试 ====================

async function testNodeReachability(server: string, port: number): Promise<{ ok: boolean; latency?: number; error?: string }> {
  const start = Date.now();
  try {
    const socket = connect({ hostname: server, port });
    await Promise.race([
      socket.opened,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('连接超时')), 5000)),
    ]);
    const latency = Date.now() - start;
    await socket.close();
    return { ok: true, latency };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function testNewNode(request: Request): Promise<Response> {
  if (requestTooLarge(request, MAX_NODE_YAML_BYTES)) {
    return Response.json({ error: '节点 YAML 过大' }, { status: 413 });
  }
  const body = (await request.json()) as { yaml: string };
  if (!body.yaml) return Response.json({ error: 'yaml 必填' }, { status: 400 });
  if (utf8ByteLength(body.yaml) > MAX_NODE_YAML_BYTES) {
    return Response.json({ error: '节点 YAML 过大' }, { status: 413 });
  }

  let node: ProxyNode;
  try {
    node = parseYaml<ProxyNode>(body.yaml);
    if (!isProxyNode(node)) {
      return Response.json({ error: '节点结构无效' }, { status: 400 });
    }
  } catch {
    return Response.json({ error: 'YAML 解析失败' }, { status: 400 });
  }

  const result = await testNodeReachability(node.server, node.port);
  return Response.json(result);
}

export async function testExistingNode(name: string, env: Env): Promise<Response> {
  const config = await loadActiveDesiredConfig(env.KV);
  const node = config.customNodes.find((item) => item.name === name);
  if (!node) return Response.json({ error: '不存在' }, { status: 404 });

  const result = await testNodeReachability(node.server, node.port);
  return Response.json(result);
}

// ==================== 脚本管理 ====================

export async function getRouting(env: Env): Promise<Response> {
  const config = await loadActiveDesiredConfig(env.KV);
  return Response.json({
    revision: config.revision,
    yaml: config.policy.routingProfile ? stringifyYaml(config.policy.routingProfile) : '',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function updateRouting(request: Request, env: Env): Promise<Response> {
  if (requestTooLarge(request, MAX_MERGE_BYTES)) {
    return Response.json({ error: '策略请求过大' }, { status: 413 });
  }
  const text = await request.text();
  if (utf8ByteLength(text) > MAX_MERGE_BYTES) {
    return Response.json({ error: '策略请求过大' }, { status: 413 });
  }
  let body: { yaml?: unknown; expectedRevision?: unknown };
  try { body = JSON.parse(text); } catch {
    return Response.json({ error: '请求必须是 JSON' }, { status: 400 });
  }
  if (!body || typeof body.yaml !== 'string' || typeof body.expectedRevision !== 'string') {
    return Response.json({ error: '缺少 yaml 或 expectedRevision' }, { status: 400 });
  }
  try {
    const current = await loadActiveDesiredConfig(env.KV);
    if (current.revision !== body.expectedRevision) throw new ConfigConflictError(current.revision);
    const draft = structuredClone(toDraft(current));
    draft.policy.routingProfile = parseRoutingYaml(body.yaml);
    const artifact = await buildDefaultMaterializedArtifact(draft, env);
    const result = await publishDesiredConfig(env.KV, draft, {
      expectedRevision: current.revision,
      materializedArtifact: artifact,
    });
    return Response.json({ ok: true, revision: result.config.revision });
  } catch (error) {
    if (error instanceof RoutingValidationError || error instanceof ConfigConflictError) {
      return mutationError(error);
    }
    return Response.json({ error: '策略生成验证失败，未发布；请检查节点缓存和引用' }, { status: 400 });
  }
}

export async function getScript(env: Env): Promise<Response> {
  void env;
  return Response.json({
    base: builtinScriptContent,
    override: '',
    overrideEnabled: false,
    materializedGenerator: 'compiled',
    storage: 'build-time',
  });
}

export async function updateScript(_request: Request, _env: Env): Promise<Response> {
  return Response.json(
    { error: '动态 JavaScript 覆盖已停用；Materialized 配置只使用部署时编译的生成器' },
    { status: 410 }
  );
}

export async function importBaseScript(request: Request, env: Env): Promise<Response> {
  void request;
  void env;
  return Response.json(
    { error: '运行时脚本写入已停用；请修改仓库脚本并通过构建发布' },
    { status: 410 }
  );
}

// ==================== 外部脚本 URL ====================

export async function getScriptUrl(env: Env): Promise<Response> {
  void env;
  return Response.json({ url: '', retired: true });
}

export async function setScriptUrl(request: Request, env: Env): Promise<Response> {
  void request;
  void env;
  return Response.json(
    { error: '外部运行时脚本同步已停用' },
    { status: 410 }
  );
}

export async function syncScriptFromUrl(env: Env): Promise<Response> {
  void env;
  return Response.json(
    { error: '外部运行时脚本同步已停用' },
    { status: 410 }
  );
}

// ==================== 导入导出 ====================

export async function importMerge(request: Request, env: Env): Promise<Response> {
  if (requestTooLarge(request, MAX_MERGE_BYTES)) {
    return Response.json({ error: 'Merge YAML 过大' }, { status: 413 });
  }
  const body = (await request.json()) as {
    yaml: string;
    action?: 'preview' | 'apply';
    strategy?: string;
    baseRevision?: string;
  };
  if (!body.yaml) return Response.json({ error: 'yaml 必填' }, { status: 400 });
  if (utf8ByteLength(body.yaml) > MAX_MERGE_BYTES) {
    return Response.json({ error: 'Merge YAML 过大' }, { status: 413 });
  }

  try {
    if ((body.action ?? 'preview') === 'preview') {
      const preview = await previewMergeImport(env.KV, body.yaml);
      return Response.json({ ok: true, action: 'preview', ...preview });
    }

    if (!body.baseRevision) {
      return Response.json({ error: 'apply 必须提供 baseRevision' }, { status: 400 });
    }
    let cacheWarnings: string[] = [];
    let preparedArtifact: MaterializedArtifact | undefined;
    const applied = await applyMergeImport(env.KV, body.yaml, {
      strategy: body.strategy ?? '',
      baseRevision: body.baseRevision,
      prepare: async (desired) => {
        cacheWarnings = await prepareConfiguredCaches(desired, env);
        preparedArtifact = await buildDefaultMaterializedArtifact(desired, env);
        return preparedArtifact;
      },
    });
    const artifact = preparedArtifact
      ? {
        ok: true,
        revision: applied.revision,
        bytes: utf8ByteLength(preparedArtifact.yaml),
      }
      : { ok: true, revision: applied.revision };
    return Response.json({
      ok: true,
      action: 'apply',
      cacheWarnings,
      artifact,
      ...applied,
    });
  } catch (error) {
    if (error instanceof MergeValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ConfigConflictError) {
      return Response.json(
        { error: error.message, currentRevision: error.currentRevision },
        { status: 409 }
      );
    }
    if (error instanceof ConfigStateError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (error instanceof ConfigReadinessError) {
      return Response.json(
        {
          error: error.message,
          code: 'CACHE_NOT_READY',
          upstreams: error.upstreams,
          hint: 'server 模式请检查抓取；mirror 模式请先用受信任镜像预载接口上传缓存',
        },
        { status: 409 }
      );
    }
    if (error instanceof Error && error.message === '仅支持 strategy: replace') {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

export async function exportMerge(env: Env): Promise<Response> {
  const config = await loadActiveDesiredConfig(env.KV);
  const yamlText = serializeMergeConfig(toDraft(config));
  return new Response(yamlText, {
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="merge.yaml"',
    },
  });
}
