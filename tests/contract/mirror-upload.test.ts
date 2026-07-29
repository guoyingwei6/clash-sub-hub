import { describe, expect, it } from 'vitest';
import { upstreamIdForName } from '../../src/domain/merge';
import {
  handleMirrorStageUpload,
  handleMirrorUpload,
  mirrorSigningPayload,
} from '../../src/mirror';
import { Env } from '../../src/types';
import { getUpstreamCache, getUpstreamState } from '../../src/storage/upstream-cache';
import { loadActiveDesiredConfig } from '../../src/storage/config-state';
import { FakeKv } from '../helpers/fake-kv';
import { stringifyYaml } from '../../src/yaml';

const upstreamName = 'fixture-mirror';
const upstreamId = upstreamIdForName(upstreamName);
const mirrorSecret = 'fixture-mirror-upload-secret';
const now = new Date('2026-01-01T00:00:00.000Z');
const timestamp = String(Math.floor(now.getTime() / 1000));
const nonce = 'fixture-nonce-0001';
const content = stringifyYaml({
  proxies: [{
    name: 'fixture-mirror-node',
    type: 'ss',
    server: '203.0.113.55',
    port: 443,
    cipher: 'aes-128-gcm',
    password: 'fixture-password',
  }],
});

function createEnvironment(localFetch = true): { env: Env; kv: FakeKv } {
  const kv = new FakeKv({
    upstreams: JSON.stringify([{
      name: upstreamName,
      url: 'https://mirror-source.invalid/subscription',
      userAgent: 'fixture-client',
      localFetch,
      lastUpdate: null,
      nodeCount: 0,
      lastError: null,
    }]),
    'custom-nodes': '[]',
  });
  return {
    kv,
    env: {
      KV: kv as unknown as KVNamespace,
      ADMIN_PASSWORD: 'fixture-admin-password',
      MIRROR_UPLOAD_SECRET: mirrorSecret,
    },
  };
}

describe('trusted mirror upload', () => {
  it('accepts a fresh HMAC-signed cache and updates runtime state', async () => {
    const { env, kv } = createEnvironment();
    const request = await signedRequest(content, timestamp, mirrorSecret);
    const response = await handleMirrorUpload(upstreamId, request, env, { now: () => now });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, nodeCount: 1 });

    const config = await loadActiveDesiredConfig(kv);
    const upstream = config.upstreams[0];
    expect((await getUpstreamCache(kv, upstream))?.content).toContain('fixture-mirror-node');
    expect(await getUpstreamState(kv, upstream)).toMatchObject({
      lastSuccessAt: now.toISOString(),
      nodeCount: 1,
      consecutiveFailures: 0,
      lastError: null,
    });
  });

  it('rejects an invalid signature before writing cache state', async () => {
    const { env, kv } = createEnvironment();
    kv.clearOperations();
    const request = new Request(`https://worker.invalid/mirror/${upstreamId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/yaml',
        'X-Clash-Timestamp': timestamp,
        'X-Clash-Nonce': nonce,
        'X-Clash-Signature': '0'.repeat(64),
      },
      body: content,
    });

    const response = await handleMirrorUpload(upstreamId, request, env, { now: () => now });
    expect(response.status).toBe(401);
    expect(kv.operations.some((operation) => operation.type !== 'get')).toBe(false);
  });

  it('rejects stale timestamps, empty subscriptions and non-mirror upstreams', async () => {
    const stale = String(Number(timestamp) - 301);
    const first = createEnvironment();
    expect((await handleMirrorUpload(
      upstreamId,
      await signedRequest(content, stale, mirrorSecret),
      first.env,
      { now: () => now }
    )).status).toBe(401);

    const emptyContent = stringifyYaml({ proxies: [] });
    const second = createEnvironment();
    expect((await handleMirrorUpload(
      upstreamId,
      await signedRequest(emptyContent, timestamp, mirrorSecret, 'fixture-nonce-0002'),
      second.env,
      { now: () => now }
    )).status).toBe(400);

    const third = createEnvironment(false);
    expect((await handleMirrorUpload(
      upstreamId,
      await signedRequest(content, timestamp, mirrorSecret, 'fixture-nonce-0003'),
      third.env,
      { now: () => now }
    )).status).toBe(401);
  });

  it('binds the signature to the body, hides identifiers and rejects replay', async () => {
    const tampered = createEnvironment();
    const signed = await signedRequest(content, timestamp, mirrorSecret, 'fixture-nonce-0004');
    const tamperedRequest = new Request(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: `${content}\n# changed`,
    });
    expect((await handleMirrorUpload(
      upstreamId,
      tamperedRequest,
      tampered.env,
      { now: () => now }
    )).status).toBe(401);

    const hidden = createEnvironment();
    const invalidUnknown = new Request('https://worker.invalid/mirror/up_unknown', {
      method: 'POST',
      headers: {
        'X-Clash-Timestamp': timestamp,
        'X-Clash-Nonce': 'fixture-nonce-0005',
        'X-Clash-Signature': '0'.repeat(64),
      },
      body: content,
    });
    expect((await handleMirrorUpload(
      'up_unknown',
      invalidUnknown,
      hidden.env,
      { now: () => now }
    )).status).toBe(401);

    const replay = createEnvironment();
    const firstRequest = await signedRequest(
      content,
      timestamp,
      mirrorSecret,
      'fixture-nonce-0006'
    );
    expect((await handleMirrorUpload(
      upstreamId,
      firstRequest,
      replay.env,
      { now: () => now }
    )).status).toBe(200);
    const replayRequest = await signedRequest(
      content,
      timestamp,
      mirrorSecret,
      'fixture-nonce-0006'
    );
    expect((await handleMirrorUpload(
      upstreamId,
      replayRequest,
      replay.env,
      { now: () => now }
    )).status).toBe(409);
  });

  it('fails closed without a configured secret and supports signed preloading', async () => {
    const missing = createEnvironment();
    delete missing.env.MIRROR_UPLOAD_SECRET;
    expect((await handleMirrorUpload(
      upstreamId,
      await signedRequest(content, timestamp, mirrorSecret, 'fixture-nonce-0007'),
      missing.env,
      { now: () => now }
    )).status).toBe(503);

    const staged = createEnvironment();
    const config = await loadActiveDesiredConfig(staged.kv);
    const upstream = config.upstreams[0];
    const body = JSON.stringify({ upstream, content });
    const request = await signedRequest(
      body,
      timestamp,
      mirrorSecret,
      'fixture-nonce-0008',
      `/mirror-stage/${upstream.id}`
    );
    const response = await handleMirrorStageUpload(upstream.id, request, staged.env, {
      now: () => now,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, staged: true, nodeCount: 1 });
  });

  it('reports failure when cache upload succeeds but the active artifact cannot rebuild', async () => {
    const unusable = stringifyYaml({
      proxies: [{
        name: '套餐到期',
        type: 'ss',
        server: '203.0.113.77',
        port: 443,
        cipher: 'aes-128-gcm',
        password: 'fixture-password',
      }],
    });
    const failed = createEnvironment();
    const response = await handleMirrorUpload(
      upstreamId,
      await signedRequest(
        unusable,
        timestamp,
        mirrorSecret,
        'fixture-nonce-0009'
      ),
      failed.env,
      { now: () => now }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      cacheUpdated: true,
      artifactReady: false,
    });
  });
});

async function signedRequest(
  body: string,
  signedAt: string,
  secret: string,
  requestNonce = nonce,
  path = `/mirror/${upstreamId}`
): Promise<Request> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(mirrorSigningPayload(upstreamId, signedAt, requestNonce, body))
  );
  const signature = [...new Uint8Array(signatureBuffer)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');

  return new Request(`https://worker.invalid${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/yaml',
      'X-Clash-Timestamp': signedAt,
      'X-Clash-Nonce': requestNonce,
      'X-Clash-Signature': signature,
    },
    body,
  });
}
