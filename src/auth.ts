import { Env } from './types';

export function checkAdmin(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization');
  if (auth) {
    return auth === `Bearer ${env.ADMIN_PASSWORD}`;
  }
  // 也支持 query 参数（方便浏览器直接访问）
  const url = new URL(request.url);
  return url.searchParams.get('key') === env.ADMIN_PASSWORD;
}

export function unauthorized(): Response {
  return Response.json({ error: '未授权' }, { status: 401 });
}
