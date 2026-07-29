import { parseClashYaml } from './converter';
import { UpstreamDefinition } from './domain/config';
import { Env, UpstreamRuntimeState } from './types';
import { loadActiveDesiredConfig } from './storage/config-state';
import {
  putUpstreamCache,
  putUpstreamState,
  upstreamSourceFingerprint,
} from './storage/upstream-cache';
import { rebuildDefaultMaterializedArtifact } from './subscription';

const MAX_MIRROR_BODY_BYTES = 5 * 1024 * 1024;
const MAX_MIRROR_ENVELOPE_BYTES = MAX_MIRROR_BODY_BYTES + 64 * 1024;
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;
const MIRROR_REPLAY_TTL_SECONDS = 10 * 60;

export async function handleMirrorUpload(
  upstreamIdentifier: string,
  request: Request,
  env: Env,
  options: { now?: () => Date } = {}
): Promise<Response> {
  if (!env.MIRROR_UPLOAD_SECRET) {
    return Response.json({ error: '镜像上传未配置' }, { status: 503 });
  }

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_MIRROR_BODY_BYTES) {
    return Response.json({ error: '上传内容过大' }, { status: 413 });
  }

  const content = await request.text();
  if (new TextEncoder().encode(content).byteLength > MAX_MIRROR_BODY_BYTES) {
    return Response.json({ error: '上传内容过大' }, { status: 413 });
  }

  const now = options.now?.() ?? new Date();
  const timestamp = request.headers.get('X-Clash-Timestamp') || '';
  const nonce = request.headers.get('X-Clash-Nonce') || '';
  const signature = request.headers.get('X-Clash-Signature') || '';
  if (
    !isFreshTimestamp(timestamp, now)
    || !isValidNonce(nonce)
    || !await verifySignature(
    env.MIRROR_UPLOAD_SECRET,
    upstreamIdentifier,
    timestamp,
    nonce,
    content,
    signature
    )
  ) {
    return Response.json({ error: '未授权' }, { status: 401 });
  }

  const config = await loadActiveDesiredConfig(env.KV);
  const upstream = config.upstreams.find((item) => item.id === upstreamIdentifier);
  if (!upstream || upstream.fetchMode !== 'mirror') {
    return Response.json({ error: '未授权' }, { status: 401 });
  }

  const nodes = parseClashYaml(content);
  if (nodes.length === 0) {
    return Response.json({ error: '未解析到任何节点' }, { status: 400 });
  }

  if (!await consumeNonce(env, upstream.id, nonce)) {
    return Response.json({ error: '请求已使用' }, { status: 409 });
  }

  await storeMirrorCache(upstream, content, nodes.length, now, env);
  const artifact = await rebuildDefaultMaterializedArtifact(env);
  return Response.json(
    {
      ok: artifact.ok,
      cacheUpdated: true,
      nodeCount: nodes.length,
      updatedAt: now.toISOString(),
      artifactReady: artifact.ok,
      error: artifact.ok ? undefined : artifact.error,
    },
    {
      status: artifact.ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}

export async function handleMirrorStageUpload(
  upstreamId: string,
  request: Request,
  env: Env,
  options: { now?: () => Date } = {}
): Promise<Response> {
  if (!env.MIRROR_UPLOAD_SECRET) {
    return Response.json({ error: '镜像上传未配置' }, { status: 503 });
  }
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_MIRROR_ENVELOPE_BYTES) {
    return Response.json({ error: '上传内容过大' }, { status: 413 });
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_MIRROR_ENVELOPE_BYTES) {
    return Response.json({ error: '上传内容过大' }, { status: 413 });
  }

  const now = options.now?.() ?? new Date();
  const timestamp = request.headers.get('X-Clash-Timestamp') || '';
  const nonce = request.headers.get('X-Clash-Nonce') || '';
  const signature = request.headers.get('X-Clash-Signature') || '';
  if (
    !isFreshTimestamp(timestamp, now)
    || !isValidNonce(nonce)
    || !await verifySignature(
      env.MIRROR_UPLOAD_SECRET,
      upstreamId,
      timestamp,
      nonce,
      rawBody,
      signature
    )
  ) {
    return Response.json({ error: '未授权' }, { status: 401 });
  }

  let envelope: { upstream?: unknown; content?: unknown };
  try {
    envelope = JSON.parse(rawBody) as { upstream?: unknown; content?: unknown };
  } catch {
    return Response.json({ error: '镜像预载 JSON 无效' }, { status: 400 });
  }
  const upstream = parseStagedUpstream(envelope.upstream, upstreamId);
  if (!upstream || typeof envelope.content !== 'string') {
    return Response.json({ error: '镜像预载结构无效' }, { status: 400 });
  }
  if (new TextEncoder().encode(envelope.content).byteLength > MAX_MIRROR_BODY_BYTES) {
    return Response.json({ error: '上传内容过大' }, { status: 413 });
  }
  const nodes = parseClashYaml(envelope.content);
  if (nodes.length === 0) {
    return Response.json({ error: '未解析到任何节点' }, { status: 400 });
  }
  if (!await consumeNonce(env, upstream.id, nonce)) {
    return Response.json({ error: '请求已使用' }, { status: 409 });
  }

  await storeMirrorCache(upstream, envelope.content, nodes.length, now, env);
  return Response.json(
    { ok: true, staged: true, nodeCount: nodes.length, updatedAt: now.toISOString() },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

async function storeMirrorCache(
  upstream: UpstreamDefinition,
  content: string,
  nodeCount: number,
  now: Date,
  env: Env
): Promise<void> {
  const updatedAt = now.toISOString();
  const sourceFingerprint = await upstreamSourceFingerprint(upstream);
  await putUpstreamCache(env.KV, {
    schemaVersion: 1,
    upstreamId: upstream.id,
    sourceFingerprint,
    updatedAt,
    nodeCount,
    content,
  });
  const state: UpstreamRuntimeState = {
    upstreamId: upstream.id,
    lastAttemptAt: updatedAt,
    lastSuccessAt: updatedAt,
    cacheUpdatedAt: updatedAt,
    nodeCount,
    lastError: null,
    consecutiveFailures: 0,
    nextRetryAt: null,
    sourceFingerprint,
  };
  await putUpstreamState(env.KV, state);
}

export function mirrorSigningPayload(
  upstreamId: string,
  timestamp: string,
  nonce: string,
  content: string
): string {
  return `${timestamp}\n${nonce}\n${upstreamId}\n${content}`;
}

async function verifySignature(
  secret: string,
  upstreamId: string,
  timestamp: string,
  nonce: string,
  content: string,
  providedHex: string
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/i.test(providedHex)) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(mirrorSigningPayload(upstreamId, timestamp, nonce, content))
  );
  const expected = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return constantTimeEqual(expected, providedHex.toLowerCase());
}

function isFreshTimestamp(value: string, now: Date): boolean {
  if (!/^\d{10}$/.test(value)) return false;
  const seconds = Number(value);
  return Math.abs(Math.floor(now.getTime() / 1000) - seconds) <= MAX_TIMESTAMP_SKEW_SECONDS;
}

function isValidNonce(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

async function consumeNonce(env: Env, upstreamId: string, nonce: string): Promise<boolean> {
  const key = `mirror-replay:${upstreamId}:${nonce}`;
  if (await env.KV.get(key)) return false;
  await env.KV.put(key, '1', { expirationTtl: MIRROR_REPLAY_TTL_SECONDS });
  return true;
}

function parseStagedUpstream(value: unknown, expectedId: string): UpstreamDefinition | null {
  if (!isRecord(value)) return null;
  if (
    value.id !== expectedId
    || typeof value.name !== 'string'
    || !value.name.trim()
    || typeof value.url !== 'string'
    || typeof value.userAgent !== 'string'
    || typeof value.prefix !== 'string'
    || value.fetchMode !== 'mirror'
    || typeof value.required !== 'boolean'
    || !isRecord(value.providerOptions)
  ) {
    return null;
  }
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  if (value.exclude !== undefined && typeof value.exclude !== 'string') return null;
  return value as unknown as UpstreamDefinition;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
