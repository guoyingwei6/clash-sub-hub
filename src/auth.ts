import { DeploymentEnvironment, Env } from './types';

export const ADMIN_SESSION_TTL_SECONDS = 15 * 60;
export const ADMIN_SESSION_COOKIE = '__Host-clash_admin_session';
export type ReportedDeploymentEnvironment = DeploymentEnvironment | 'unknown';

export function deploymentEnvironment(
  env: Pick<Env, 'DEPLOYMENT_ENVIRONMENT'>
): ReportedDeploymentEnvironment {
  return env.DEPLOYMENT_ENVIRONMENT === 'production'
    || env.DEPLOYMENT_ENVIRONMENT === 'staging'
    ? env.DEPLOYMENT_ENVIRONMENT
    : 'unknown';
}

export async function checkAdmin(
  request: Request,
  env: Env,
  options: { now?: () => Date } = {}
): Promise<boolean> {
  if (checkAdminPassword(request, env)) return true;
  const expected = env.ADMIN_PASSWORD?.trim();
  if (!expected) return false;

  const session = readCookie(request.headers.get('Cookie'), ADMIN_SESSION_COOKIE);
  if (!session) return false;
  const [expiresRaw, nonce, providedSignature, extra] = session.split('.');
  if (
    extra !== undefined
    || !/^\d{10}$/.test(expiresRaw || '')
    || !/^[a-f0-9]{32}$/i.test(nonce || '')
    || !/^[a-f0-9]{64}$/i.test(providedSignature || '')
  ) {
    return false;
  }

  const now = options.now?.() ?? new Date();
  const expires = Number(expiresRaw);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    expires < nowSeconds
    || expires > nowSeconds + ADMIN_SESSION_TTL_SECONDS
  ) {
    return false;
  }

  const expectedSignature = await hmacHex(
    expected,
    `${deploymentEnvironment(env)}.${expiresRaw}.${nonce}`
  );
  return constantTimeEqual(
    expectedSignature,
    providedSignature.toLowerCase()
  );
}

export async function createAdminSession(
  request: Request,
  env: Env,
  options: { now?: () => Date; nonceFactory?: () => string } = {}
): Promise<Response> {
  if (!checkAdminPassword(request, env)) return unauthorized();
  const secret = env.ADMIN_PASSWORD.trim();
  const now = options.now?.() ?? new Date();
  const expires = Math.floor(now.getTime() / 1000) + ADMIN_SESSION_TTL_SECONDS;
  const nonce = options.nonceFactory?.()
    ?? crypto.randomUUID().replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/i.test(nonce)) {
    return Response.json(
      { error: '会话生成失败' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  const payload = `${expires}.${nonce.toLowerCase()}`;
  const environment = deploymentEnvironment(env);
  const signature = await hmacHex(secret, `${environment}.${payload}`);
  return Response.json(
    {
      ok: true,
      expiresAt: new Date(expires * 1000).toISOString(),
      deploymentEnvironment: environment,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        'Set-Cookie': sessionCookie(
          `${payload}.${signature}`,
          ADMIN_SESSION_TTL_SECONDS
        ),
      },
    }
  );
}

export function clearAdminSession(): Response {
  return Response.json(
    { ok: true },
    {
      headers: {
        'Cache-Control': 'no-store',
        'Set-Cookie': sessionCookie('', 0),
      },
    }
  );
}

export function adminSessionStatus(env: Env): Response {
  return Response.json(
    {
      ok: true,
      deploymentEnvironment: deploymentEnvironment(env),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

function checkAdminPassword(request: Request, env: Env): boolean {
  const expected = env.ADMIN_PASSWORD?.trim();
  if (!expected) return false;

  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return false;
  return constantTimeEqual(auth.slice('Bearer '.length), expected);
}

export function unauthorized(): Response {
  return Response.json(
    { error: '未授权' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } }
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
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
    encoder.encode(payload)
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return trimmed.slice(name.length + 1);
    }
  }
  return null;
}

function sessionCookie(value: string, maxAge: number): string {
  return [
    `${ADMIN_SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ].join('; ');
}
