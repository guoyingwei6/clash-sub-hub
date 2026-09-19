import { describe, expect, it } from 'vitest';
import {
  createUser,
  deleteUser,
  listUsers,
  rotateUserToken,
  updateUser,
} from '../../src/users';
import { hashSubscriptionToken } from '../../src/domain/token';
import { Env, User } from '../../src/types';
import { FakeKv } from '../helpers/fake-kv';
import { handleSubscription } from '../../src/subscription';

function environment(initialUsers: User[] = []): { env: Env; kv: FakeKv } {
  const kv = new FakeKv({
    users: JSON.stringify(initialUsers),
    upstreams: '[]',
    'custom-nodes': JSON.stringify([{
      name: 'fixture-custom',
      type: 'ss',
      server: '192.0.2.80',
      port: 443,
      cipher: 'aes-128-gcm',
      password: 'fixture-password',
    }]),
  });
  return {
    kv,
    env: {
      KV: kv as unknown as KVNamespace,
      ADMIN_PASSWORD: 'fixture-admin-password',
    },
  };
}

describe('user token lifecycle', () => {
  it('creates a random token once and lists only its prefix', async () => {
    const { env, kv } = environment();
    const created = await createUser(new Request('https://worker.invalid/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fixture recipient', token: 'caller-chosen-token' }),
    }), env);
    const createBody = await created.json() as { token: string };
    expect(createBody.token).toBe('caller-chosen-token');

    const stored = JSON.parse(kv.peek('users') || '[]') as User[];
    expect(stored).toHaveLength(1);
    expect(stored[0].token).toBeUndefined();
    expect(stored[0].tokenHash).toBe(await hashSubscriptionToken(createBody.token));
    expect(JSON.stringify(stored)).not.toContain(createBody.token);
    expect(JSON.stringify(stored)).not.toContain('caller-chosen-token');

    const listed = await listUsers(env);
    const users = await listed.json() as Record<string, unknown>[];
    expect(users[0]).toMatchObject({
      name: 'fixture recipient',
      tokenPrefix: createBody.token.slice(0, 8),
      legacyToken: false,
      allowProviderMode: false,
    });
    expect(users[0]).not.toHaveProperty('token');
    expect(users[0]).not.toHaveProperty('tokenHash');
  });

  it('rotates legacy tokens, applies permissions and deletes by stable id', async () => {
    const { env, kv } = environment([{
      token: 'fixture-legacy-token',
      name: 'fixture legacy',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    }]);
    const listed = await listUsers(env);
    const [legacyView] = await listed.json() as Array<{ id: string; legacyToken: boolean }>;
    expect(legacyView.legacyToken).toBe(false);
    expect(kv.peek('users')).not.toContain('fixture-legacy-token');
    expect((await handleSubscription(
      'fixture-legacy-token',
      null,
      'nodes',
      env
    )).status).toBe(200);

    const rotated = await rotateUserToken(legacyView.id, new Request('https://example.com/api', { method: 'POST', body: '{}' }), env);
    const rotateBody = await rotated.json() as { token: string };
    const afterRotate = JSON.parse(kv.peek('users') || '[]') as User[];
    expect(afterRotate[0].token).toBeUndefined();
    expect(afterRotate[0].tokenHash).toBe(await hashSubscriptionToken(rotateBody.token));
    expect((await handleSubscription(
      'fixture-legacy-token',
      null,
      'nodes',
      env
    )).status).toBe(403);
    expect((await handleSubscription(
      rotateBody.token,
      null,
      'nodes',
      env
    )).status).toBe(200);
    expect(kv.peek('users')).not.toContain('fixture-legacy-token');
    expect(kv.peek('users')).not.toContain(rotateBody.token);

    const updated = await updateUser(legacyView.id, new Request('https://worker.invalid', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: false,
        allowProviderMode: true,
        allowedUpstreams: [],
        allowedCustomNodes: ['fixture-node'],
      }),
    }), env);
    expect(updated.status).toBe(200);
    expect(JSON.parse(kv.peek('users') || '[]')[0]).toMatchObject({
      enabled: false,
      allowProviderMode: true,
      allowedUpstreams: [],
      allowedCustomNodes: ['fixture-node'],
    });

    expect((await deleteUser(legacyView.id, env)).status).toBe(200);
    expect(JSON.parse(kv.peek('users') || '[]')).toEqual([]);
  });
});
