#!/usr/bin/env node
/**
 * Trusted mirror producer.
 *
 * Required environment variables:
 *   CLASH_SUB_HUB_URL       e.g. https://hub.example.test
 *   MIRROR_UPLOAD_SECRET    Worker secret (never pass it on the command line)
 *
 * Usage:
 *   node scripts/mirror-upload.mjs --definition /secure/upstream.json
 *   node scripts/mirror-upload.mjs --definition /secure/upstream.json --stage
 *
 * The definition file is one UpstreamDefinition JSON object. It is deliberately
 * kept outside the repository because it contains the original subscription URL.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

process.on('uncaughtException', () => {
  console.error('镜像任务失败（详细地址和凭据已隐藏）');
  process.exit(1);
});
process.on('unhandledRejection', () => {
  console.error('镜像任务失败（详细地址和凭据已隐藏）');
  process.exit(1);
});

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === '--stage') {
    argumentsByName.set('stage', true);
    continue;
  }
  if (argument.startsWith('--') && process.argv[index + 1]) {
    argumentsByName.set(argument.slice(2), process.argv[index + 1]);
    index += 1;
  }
}

const definitionPath = argumentsByName.get('definition');
const hubUrl = process.env.CLASH_SUB_HUB_URL?.replace(/\/+$/, '');
const secret = process.env.MIRROR_UPLOAD_SECRET;
if (!definitionPath || !hubUrl || !secret) {
  console.error(
    '缺少参数：需要 --definition、CLASH_SUB_HUB_URL 和 MIRROR_UPLOAD_SECRET'
  );
  process.exit(2);
}

const upstream = JSON.parse(await readFile(definitionPath, 'utf8'));
if (
  !upstream
  || typeof upstream.id !== 'string'
  || typeof upstream.url !== 'string'
  || upstream.fetchMode !== 'mirror'
) {
  console.error('definition 必须是 fetchMode=mirror 的 UpstreamDefinition JSON');
  process.exit(2);
}

const sourceResponse = await fetch(upstream.url, {
  headers: {
    'User-Agent': upstream.userAgent || 'clash.meta',
    Accept: '*/*',
  },
  redirect: 'follow',
  signal: AbortSignal.timeout(30_000),
});
if (!sourceResponse.ok) {
  console.error(`上游抓取失败：HTTP ${sourceResponse.status}`);
  process.exit(1);
}
const content = await readTextLimited(sourceResponse, 5 * 1024 * 1024);
const stage = argumentsByName.get('stage') === true;
const body = stage ? JSON.stringify({ upstream, content }) : content;
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomBytes(18).toString('base64url');
const signingPayload = `${timestamp}\n${nonce}\n${upstream.id}\n${body}`;
const signature = createHmac('sha256', secret)
  .update(signingPayload)
  .digest('hex');
const path = stage ? `/mirror-stage/${upstream.id}` : `/mirror/${upstream.id}`;

const uploadResponse = await fetch(`${hubUrl}${path}`, {
  method: 'POST',
  headers: {
    'Content-Type': stage ? 'application/json' : 'text/yaml',
    'X-Clash-Timestamp': timestamp,
    'X-Clash-Nonce': nonce,
    'X-Clash-Signature': signature,
  },
  body,
  signal: AbortSignal.timeout(30_000),
});
const result = await uploadResponse.text();
if (!uploadResponse.ok) {
  console.error(`镜像上传失败：HTTP ${uploadResponse.status} ${result.slice(0, 200)}`);
  process.exit(1);
}
let resultPayload;
try {
  resultPayload = JSON.parse(result);
} catch {
  console.error('镜像上传失败：服务端返回结构无效');
  process.exit(1);
}
if (
  resultPayload?.ok !== true
  || (!stage && resultPayload.artifactReady !== true)
) {
  console.error('镜像上传失败：缓存已提交但完整订阅尚未就绪');
  process.exit(1);
}
console.log(`镜像上传成功：${upstream.id}${stage ? ' (staged)' : ''}`);

async function readTextLimited(response, maxBytes) {
  const declared = Number(response.headers.get('Content-Length') || 0);
  if (declared > maxBytes) throw new Error('上游响应超过 5 MiB 限制');
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('上游响应超过 5 MiB 限制');
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
