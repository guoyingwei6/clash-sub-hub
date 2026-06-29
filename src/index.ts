import { Env } from './types';
import { checkAdmin, unauthorized } from './auth';
import { handleMerge, handleSubscription } from './subscription';
import { handleScheduled } from './cron';
import { builtinScriptContent } from './generated/script-content';
import {
  listUsers, createUser, updateUser, deleteUser,
  listUpstreams, createUpstream, updateUpstream, deleteUpstream,
  testUpstream, testExistingUpstream, listUpstreamNodes, testUpstreamNode, refreshOne, refreshAll,
  listCustomNodes, createCustomNode, updateCustomNode, deleteCustomNode, testNewNode, testExistingNode,
  getScript, updateScript, importBaseScript,
  getScriptUrl, setScriptUrl, syncScriptFromUrl,
  importMerge, exportMerge,
  getSettings, updateSettings,
} from './admin';
import UI_HTML from './ui.html';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS
    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // 公开接口：订阅
    const subMatch = path.match(/^\/sub\/([^/]+)$/);
    if (subMatch) {
      const format = url.searchParams.get('format');
      const mode = url.searchParams.get('mode');
      return handleSubscription(subMatch[1], format, mode, env);
    }

    // 公开接口：Clash Verge Merge 覆写配置
    const mergeMatch = path.match(/^\/merge\/([^/]+)$/);
    if (mergeMatch) {
      return handleMerge(mergeMatch[1], env);
    }

    // 公开接口：全局扩展脚本（KV override 优先，否则返回内置版本）
    if (path === '/script.js') {
      const script = await env.KV.get('script-base') || await env.KV.get('script') || builtinScriptContent;
      return new Response(script, {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
      });
    }

    // 管理页面
    if (path === '/admin' || path === '/admin/') {
      return new Response(UI_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 以下均为管理 API，需要鉴权
    if (path.startsWith('/api/')) {
      if (!checkAdmin(request, env)) return unauthorized();
      const resp = await routeApi(path, method, request, env);
      return addCors(resp);
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleScheduled(env);
  },
};

async function routeApi(
  path: string,
  method: string,
  request: Request,
  env: Env
): Promise<Response> {
  // 用户
  if (path === '/api/users' && method === 'GET') return listUsers(env);
  if (path === '/api/users' && method === 'POST') return createUser(request, env);

  const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch) {
    const token = decodeURIComponent(userMatch[1]);
    if (method === 'PUT') return updateUser(token, request, env);
    if (method === 'DELETE') return deleteUser(token, env);
  }

  // 上游订阅
  if (path === '/api/upstreams' && method === 'GET') return listUpstreams(env);
  if (path === '/api/upstreams' && method === 'POST') return createUpstream(request, env);
  if (path === '/api/upstreams/test' && method === 'POST') return testUpstream(request);

  const upstreamNodesMatch = path.match(/^\/api\/upstreams\/([^/]+)\/nodes$/);
  if (upstreamNodesMatch && method === 'GET') {
    return listUpstreamNodes(decodeURIComponent(upstreamNodesMatch[1]), env);
  }

  const upstreamNodeTestMatch = path.match(/^\/api\/upstreams\/([^/]+)\/nodes\/test$/);
  if (upstreamNodeTestMatch && method === 'POST') {
    return testUpstreamNode(decodeURIComponent(upstreamNodeTestMatch[1]), request, env);
  }

  const upstreamTestMatch = path.match(/^\/api\/upstreams\/([^/]+)\/test$/);
  if (upstreamTestMatch && method === 'POST') {
    return testExistingUpstream(decodeURIComponent(upstreamTestMatch[1]), env);
  }

  const upstreamRefreshMatch = path.match(/^\/api\/upstreams\/([^/]+)\/refresh$/);
  if (upstreamRefreshMatch && method === 'POST') {
    return refreshOne(decodeURIComponent(upstreamRefreshMatch[1]), env);
  }

  const upstreamMatch = path.match(/^\/api\/upstreams\/([^/]+)$/);
  if (upstreamMatch) {
    const name = decodeURIComponent(upstreamMatch[1]);
    if (method === 'PUT') return updateUpstream(name, request, env);
    if (method === 'DELETE') return deleteUpstream(name, env);
  }

  // 刷新
  if (path === '/api/refresh' && method === 'POST') return refreshAll(env);

  // 自建节点
  if (path === '/api/custom-nodes' && method === 'GET') return listCustomNodes(env);
  if (path === '/api/custom-nodes' && method === 'POST') return createCustomNode(request, env);
  if (path === '/api/custom-nodes/test' && method === 'POST') return testNewNode(request);

  const nodeTestMatch = path.match(/^\/api\/custom-nodes\/([^/]+)\/test$/);
  if (nodeTestMatch && method === 'POST') {
    return testExistingNode(decodeURIComponent(nodeTestMatch[1]), env);
  }

  const nodeMatch = path.match(/^\/api\/custom-nodes\/([^/]+)$/);
  if (nodeMatch) {
    const name = decodeURIComponent(nodeMatch[1]);
    if (method === 'PUT') return updateCustomNode(name, request, env);
    if (method === 'DELETE') return deleteCustomNode(name, env);
  }

  // 脚本
  if (path === '/api/script' && method === 'GET') return getScript(env);
  if (path === '/api/script' && method === 'POST') return updateScript(request, env);
  if (path === '/api/script/import-base' && method === 'POST') return importBaseScript(request, env);

  // 外部脚本 URL
  if (path === '/api/script-url' && method === 'GET') return getScriptUrl(env);
  if (path === '/api/script-url' && method === 'POST') return setScriptUrl(request, env);
  if (path === '/api/script-url/sync' && method === 'POST') return syncScriptFromUrl(env);

  // 全局设置
  if (path === '/api/settings' && method === 'GET') return getSettings(env);
  if (path === '/api/settings' && method === 'POST') return updateSettings(request, env);

  // 导入导出
  if (path === '/api/import/merge' && method === 'POST') return importMerge(request, env);
  if (path === '/api/export/merge' && method === 'GET') return exportMerge(env);

  return Response.json({ error: 'Not Found' }, { status: 404 });
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function addCors(resp: Response): Response {
  const headers = new Headers(resp.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(resp.body, { status: resp.status, headers });
}
