import { describe, expect, it } from 'vitest';
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
  adminSessionStatus,
  checkAdmin,
  clearAdminSession,
  createAdminSession,
  deploymentEnvironment,
} from '../../src/auth';
import {
  STAGING_PROVIDER_PATH,
  handleStagingProvider,
} from '../../src/staging-fixture';
import { DeploymentEnvironment, Env } from '../../src/types';
import { FakeKv } from '../helpers/fake-kv';

function environment(
  password: string | undefined,
  environmentName: DeploymentEnvironment = 'production'
): Env {
  return {
    KV: new FakeKv() as unknown as KVNamespace,
    ADMIN_PASSWORD: password as string,
    DEPLOYMENT_ENVIRONMENT: environmentName,
  };
}

describe('administrator authentication', () => {
  it('fails closed when the Worker secret is absent or blank', async () => {
    const undefinedBearer = new Request('https://worker.invalid/api/users', {
      headers: { Authorization: 'Bearer undefined' },
    });
    expect(await checkAdmin(undefinedBearer, environment(undefined))).toBe(false);
    expect(await checkAdmin(undefinedBearer, environment(''))).toBe(false);
  });

  it('accepts only an exact non-empty bearer token', async () => {
    const env = environment('fixture-admin-password');
    expect(await checkAdmin(new Request('https://worker.invalid/api/users', {
      headers: { Authorization: 'Bearer fixture-admin-password' },
    }), env)).toBe(true);
    expect(await checkAdmin(new Request('https://worker.invalid/api/users', {
      headers: { Authorization: 'Bearer fixture-admin-password-extra' },
    }), env)).toBe(false);
    expect(await checkAdmin(new Request('https://worker.invalid/api/users'), env)).toBe(false);
  });

  it('exchanges the password for a bounded HttpOnly signed session', async () => {
    const env = environment('fixture-admin-password', 'staging');
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const response = await createAdminSession(
      new Request('https://worker.invalid/api/admin/session', {
        method: 'POST',
        headers: { Authorization: 'Bearer fixture-admin-password' },
      }),
      env,
      {
        now: () => issuedAt,
        nonceFactory: () => '0123456789abcdef0123456789abcdef',
      }
    );
    const setCookie = response.headers.get('Set-Cookie') || '';
    expect(response.status).toBe(200);
    expect(setCookie).toContain(`${ADMIN_SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain(`Max-Age=${ADMIN_SESSION_TTL_SECONDS}`);
    expect(setCookie).not.toContain('fixture-admin-password');
    expect(await response.clone().json()).toMatchObject({
      ok: true,
      deploymentEnvironment: 'staging',
    });

    const cookie = setCookie.split(';', 1)[0];
    const sessionRequest = new Request('https://worker.invalid/api/users', {
      headers: { Cookie: cookie },
    });
    expect(await checkAdmin(sessionRequest, env, { now: () => issuedAt })).toBe(true);
    expect(await checkAdmin(sessionRequest, env, {
      now: () => new Date(
        issuedAt.getTime() + (ADMIN_SESSION_TTL_SECONDS + 1) * 1000
      ),
    })).toBe(false);

    const tamperedCookie = `${cookie.slice(0, -1)}${cookie.endsWith('0') ? '1' : '0'}`;
    const tampered = new Request('https://worker.invalid/api/users', {
      headers: { Cookie: tamperedCookie },
    });
    expect(await checkAdmin(tampered, env, { now: () => issuedAt })).toBe(false);

    const cleared = clearAdminSession().headers.get('Set-Cookie') || '';
    expect(cleared).toContain(`${ADMIN_SESSION_COOKIE}=`);
    expect(cleared).toContain('Max-Age=0');
  });

  it('binds sessions to the runtime environment and reports it on GET', async () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const staging = environment('fixture-admin-password', 'staging');
    const issued = await createAdminSession(
      new Request('https://worker.invalid/api/admin/session', {
        method: 'POST',
        headers: { Authorization: 'Bearer fixture-admin-password' },
      }),
      staging,
      {
        now: () => issuedAt,
        nonceFactory: () => 'fedcba9876543210fedcba9876543210',
      }
    );
    const cookie = (issued.headers.get('Set-Cookie') || '').split(';', 1)[0];
    const sessionRequest = new Request('https://worker.invalid/api/admin/session', {
      headers: { Cookie: cookie },
    });

    expect(await checkAdmin(sessionRequest, staging, { now: () => issuedAt })).toBe(true);
    expect(await checkAdmin(
      sessionRequest,
      environment('fixture-admin-password', 'production'),
      { now: () => issuedAt }
    )).toBe(false);

    const status = adminSessionStatus(staging);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      ok: true,
      deploymentEnvironment: 'staging',
    });
    expect(deploymentEnvironment({})).toBe('unknown');
  });

  it('exposes the credential-free provider fixture only in staging', async () => {
    const staging = handleStagingProvider(
      STAGING_PROVIDER_PATH,
      'GET',
      environment('fixture-admin-password', 'staging')
    );
    expect(staging?.status).toBe(200);
    expect(staging?.headers.get('Content-Type')).toContain('text/yaml');
    const yaml = await staging!.text();
    expect(yaml).toContain('192.0.2.200');
    expect(yaml).toContain('type: socks5');
    expect(yaml).not.toMatch(/password|token|uuid|private-key/i);

    const production = handleStagingProvider(
      STAGING_PROVIDER_PATH,
      'GET',
      environment('fixture-admin-password', 'production')
    );
    expect(production?.status).toBe(404);

    const unknownEnvironment = environment('fixture-admin-password');
    delete unknownEnvironment.DEPLOYMENT_ENVIRONMENT;
    expect(handleStagingProvider(
      STAGING_PROVIDER_PATH,
      'GET',
      unknownEnvironment
    )?.status).toBe(404);
    expect(handleStagingProvider('/not-a-fixture', 'GET', unknownEnvironment)).toBeNull();
  });
});
