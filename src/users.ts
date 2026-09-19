import { Env, User } from './types';
import {
  hashSubscriptionToken,
  issueSubscriptionToken,
  legacyUserId,
  newUserId,
  TokenValidationError,
} from './domain/token';

export async function listUsers(env: Env): Promise<Response> {
  const users = await loadUsers(env);
  return Response.json(await Promise.all(users.map(async (user) => ({
    id: await resolvedUserId(user),
    name: user.name,
    enabled: user.enabled,
    createdAt: user.createdAt,
    allowedUpstreams: user.allowedUpstreams,
    allowedCustomNodes: user.allowedCustomNodes,
    filterNodes: user.filterNodes,
    allowProviderMode: user.allowProviderMode === true,
    tokenPrefix: user.tokenPrefix || user.token?.slice(0, 8) || '',
    legacyToken: false,
  }))));
}

export async function createUser(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { name: string; token?: string };
  if (!body.name?.trim()) return Response.json({ error: 'name 必填' }, { status: 400 });

  const users = await loadUsers(env);
  let issued;
  try {
    issued = await issueSubscriptionToken(body.token?.trim() || undefined);
  } catch (e) {
    if (e instanceof TokenValidationError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
  if (body.token?.trim() && users.some(u => u.tokenHash === issued.tokenHash)) {
    return Response.json({ error: '该链接已被使用' }, { status: 409 });
  }

  users.push({
    id: newUserId(),
    tokenHash: issued.tokenHash,
    tokenPrefix: issued.tokenPrefix,
    name: body.name.trim(),
    enabled: true,
    createdAt: new Date().toISOString(),
  });

  await env.KV.put('users', JSON.stringify(users));
  return Response.json({ ok: true, token: issued.token });
}

export async function updateUser(
  identifier: string,
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as {
    enabled?: boolean;
    name?: string;
    allowedUpstreams?: string[] | null;
    allowedCustomNodes?: string[] | null;
    filterNodes?: boolean | null;
    allowProviderMode?: boolean;
  };
  const users = await loadUsers(env);
  if (users.length === 0) {
    return Response.json({ error: '用户不存在' }, { status: 404 });
  }
  const userIndex = await findUserIndex(users, identifier);
  if (userIndex === -1) return Response.json({ error: '用户不存在' }, { status: 404 });
  const user = users[userIndex];
  user.id = await resolvedUserId(user);

  if (body.enabled !== undefined) user.enabled = body.enabled;
  if (body.name !== undefined) user.name = body.name;
  if ('allowedUpstreams' in body) user.allowedUpstreams = body.allowedUpstreams;
  if ('allowedCustomNodes' in body) user.allowedCustomNodes = body.allowedCustomNodes;
  if ('filterNodes' in body) user.filterNodes = body.filterNodes;
  if (body.allowProviderMode !== undefined) {
    user.allowProviderMode = body.allowProviderMode;
  }

  await env.KV.put('users', JSON.stringify(users));
  return Response.json({ ok: true });
}

export async function deleteUser(identifier: string, env: Env): Promise<Response> {
  const users = await loadUsers(env);
  if (users.length === 0) {
    return Response.json({ error: '用户不存在' }, { status: 404 });
  }
  const userIndex = await findUserIndex(users, identifier);
  if (userIndex === -1) return Response.json({ error: '用户不存在' }, { status: 404 });

  users.splice(userIndex, 1);
  await env.KV.put('users', JSON.stringify(users));
  return Response.json({ ok: true });
}

export async function rotateUserToken(identifier: string, request: Request, env: Env): Promise<Response> {
  const users = await loadUsers(env);
  if (users.length === 0) {
    return Response.json({ error: '用户不存在' }, { status: 404 });
  }
  const userIndex = await findUserIndex(users, identifier);
  if (userIndex === -1) return Response.json({ error: '用户不存在' }, { status: 404 });

  const user = users[userIndex];
  const body = await request.json().catch(() => ({})) as { token?: string };
  let issued;
  try {
    issued = await issueSubscriptionToken(body.token?.trim() || undefined);
  } catch (e) {
    if (e instanceof TokenValidationError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
  if (body.token?.trim() && users.some((u, i) => i !== userIndex && u.tokenHash === issued.tokenHash)) {
    return Response.json({ error: '该链接已被使用' }, { status: 409 });
  }
  user.id = await resolvedUserId(user);
  user.tokenHash = issued.tokenHash;
  user.tokenPrefix = issued.tokenPrefix;
  delete user.token;
  await env.KV.put('users', JSON.stringify(users));
  return Response.json({ ok: true, token: issued.token });
}

async function resolvedUserId(user: User): Promise<string> {
  if (user.id) return user.id;
  if (user.token) return legacyUserId(user.token);
  return `usr_invalid_${user.createdAt}`;
}

async function loadUsers(env: Env): Promise<User[]> {
  const raw = await env.KV.get('users');
  const users: User[] = raw ? JSON.parse(raw) : [];
  let changed = false;
  for (const user of users) {
    if (!user.token || user.tokenHash) continue;
    user.id = await resolvedUserId(user);
    user.tokenHash = await hashSubscriptionToken(user.token);
    user.tokenPrefix = user.token.slice(0, 8);
    delete user.token;
    changed = true;
  }
  if (changed) await env.KV.put('users', JSON.stringify(users));
  return users;
}

async function findUserIndex(users: User[], identifier: string): Promise<number> {
  for (let index = 0; index < users.length; index += 1) {
    if (users[index].id === identifier || users[index].token === identifier) return index;
    if (await resolvedUserId(users[index]) === identifier) return index;
  }
  return -1;
}
