import yaml from 'js-yaml';
import { ProxyNode } from './types';

const FILTER_REGEX = /官网|套餐|流量|异常|剩余|ISP|all|免费|低倍率|0\.[0-9]x|测试|到期/i;

export function parseClashYaml(text: string): ProxyNode[] {
  // 1. 尝试 Clash YAML
  const yamlNodes = tryParseYaml(text);
  if (yamlNodes.length > 0) return yamlNodes;

  // 2. 尝试 base64 解码
  const trimmed = text.trim();
  try {
    const decoded = atob(trimmed);
    // 2a. 解码后尝试 YAML
    const yamlFromB64 = tryParseYaml(decoded);
    if (yamlFromB64.length > 0) return yamlFromB64;
    // 2b. 解码后尝试 URI 列表
    const uriNodes = parseUriList(decoded);
    if (uriNodes.length > 0) return uriNodes;
  } catch { /* 不是合法 base64 */ }

  // 3. 直接尝试 URI 列表（非 base64）
  return parseUriList(text);
}

function tryParseYaml(text: string): ProxyNode[] {
  try {
    const doc = yaml.load(text) as Record<string, unknown>;
    if (!doc) return [];
    const proxies = doc.proxies || doc.Proxy;
    if (!Array.isArray(proxies)) return [];
    return proxies.filter(
      (p): p is ProxyNode => p && typeof p === 'object' && 'name' in p && 'type' in p
    );
  } catch {
    return [];
  }
}

function parseUriList(text: string): ProxyNode[] {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const nodes: ProxyNode[] = [];
  for (const line of lines) {
    const node = parseUri(line);
    if (node) nodes.push(node);
  }
  return nodes;
}

function parseUri(uri: string): ProxyNode | null {
  try {
    if (uri.startsWith('vmess://')) return parseVmessUri(uri);
    if (uri.startsWith('vless://')) return parseVlessUri(uri);
    if (uri.startsWith('ss://')) return parseSsUri(uri);
    if (uri.startsWith('trojan://')) return parseTrojanUri(uri);
    if (uri.startsWith('hysteria2://') || uri.startsWith('hy2://')) return parseHy2Uri(uri);
    if (uri.startsWith('tuic://')) return parseTuicUri(uri);
  } catch { /* 解析失败跳过 */ }
  return null;
}

function decodeFragment(uri: string): string {
  const idx = uri.lastIndexOf('#');
  return idx >= 0 ? decodeURIComponent(uri.slice(idx + 1)) : '';
}

function parseParams(query: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const part of query.split('&')) {
    const [k, v] = part.split('=', 2);
    if (k) params[k] = decodeURIComponent(v || '');
  }
  return params;
}

function parseVmessUri(uri: string): ProxyNode | null {
  const json = atob(uri.slice(8));
  const obj = JSON.parse(json);
  return {
    name: obj.ps || 'vmess',
    type: 'vmess',
    server: obj.add,
    port: Number(obj.port),
    uuid: obj.id,
    alterId: Number(obj.aid || 0),
    cipher: obj.scy || 'auto',
    network: obj.net || 'tcp',
    tls: obj.tls === 'tls',
    servername: obj.sni || undefined,
    'ws-opts': obj.net === 'ws' ? { path: obj.path || '/', headers: obj.host ? { Host: obj.host } : undefined } : undefined,
  };
}

function parseVlessUri(uri: string): ProxyNode | null {
  const body = uri.slice(8);
  const name = decodeFragment(uri);
  const [userHost, queryFrag] = body.split('?', 2);
  const [uuid, hostPort] = userHost.split('@', 2);
  const [server, portStr] = hostPort.split(':', 2);
  const query = (queryFrag || '').split('#')[0];
  const p = parseParams(query);
  const node: ProxyNode = {
    name: name || 'vless',
    type: 'vless',
    server,
    port: Number(portStr),
    uuid,
    network: p.type || 'tcp',
    tls: p.security === 'tls' || p.security === 'reality',
    servername: p.sni || undefined,
    flow: p.flow || undefined,
    'client-fingerprint': p.fp || undefined,
  };
  if (p.security === 'reality') {
    node['reality-opts'] = { 'public-key': p.pbk, 'short-id': p.sid || '' };
  }
  if (p.type === 'ws') {
    node['ws-opts'] = { path: p.path || '/', headers: p.host ? { Host: p.host } : undefined };
  } else if (p.type === 'grpc') {
    node['grpc-opts'] = { 'grpc-service-name': p.serviceName || '' };
  }
  return node;
}

function parseSsUri(uri: string): ProxyNode | null {
  const name = decodeFragment(uri);
  const body = uri.slice(5).split('#')[0];
  let method: string, password: string, server: string, port: number;
  if (body.includes('@')) {
    // ss://base64(method:password)@host:port or ss://method:password@host:port
    const [userinfo, hostPort] = body.split('@', 2);
    let decoded: string;
    try { decoded = atob(userinfo); } catch { decoded = decodeURIComponent(userinfo); }
    const colonIdx = decoded.indexOf(':');
    method = decoded.slice(0, colonIdx);
    password = decoded.slice(colonIdx + 1);
    const [s, p] = hostPort.split(':', 2);
    server = s;
    port = Number(p);
  } else {
    const decoded = atob(body);
    const m = decoded.match(/^(.+?):(.+)@(.+):(\d+)$/);
    if (!m) return null;
    [, method, password, server, port] = m as unknown as [string, string, string, string, number];
    port = Number(port);
  }
  return { name: name || 'ss', type: 'ss', server, port, cipher: method, password };
}

function parseTrojanUri(uri: string): ProxyNode | null {
  const name = decodeFragment(uri);
  const body = uri.slice(9).split('#')[0];
  const [passHost, query] = body.split('?', 2);
  const [password, hostPort] = passHost.split('@', 2);
  const [server, portStr] = hostPort.split(':', 2);
  const p = query ? parseParams(query) : {};
  return {
    name: name || 'trojan',
    type: 'trojan',
    server,
    port: Number(portStr),
    password: decodeURIComponent(password),
    sni: p.sni || undefined,
    network: p.type || 'tcp',
    'skip-cert-verify': p.allowInsecure === '1' || undefined,
  };
}

function parseHy2Uri(uri: string): ProxyNode | null {
  const name = decodeFragment(uri);
  const proto = uri.startsWith('hy2://') ? 6 : 12;
  const body = uri.slice(proto).split('#')[0];
  const [passHost, query] = body.split('?', 2);
  const [password, hostPort] = passHost.split('@', 2);
  const [server, portStr] = hostPort.split(':', 2);
  const p = query ? parseParams(query) : {};
  return {
    name: name || 'hysteria2',
    type: 'hysteria2',
    server,
    port: Number(portStr),
    password: decodeURIComponent(password),
    sni: p.sni || undefined,
    'skip-cert-verify': p.insecure === '1' || undefined,
    obfs: p.obfs || undefined,
    'obfs-password': p['obfs-password'] || undefined,
  };
}

function parseTuicUri(uri: string): ProxyNode | null {
  const name = decodeFragment(uri);
  const body = uri.slice(7).split('#')[0];
  const [userHost, query] = body.split('?', 2);
  const [userPass, hostPort] = userHost.split('@', 2);
  const [uuid, password] = userPass.split(':', 2);
  const [server, portStr] = hostPort.split(':', 2);
  const p = query ? parseParams(query) : {};
  return {
    name: name || 'tuic',
    type: 'tuic',
    server,
    port: Number(portStr),
    uuid,
    password,
    'congestion-controller': p.congestion_control || 'bbr',
    'udp-relay-mode': p.udp_relay_mode || 'native',
    sni: p.sni || undefined,
    'skip-cert-verify': p.allow_insecure === '1' || undefined,
  };
}

export function filterNodes(nodes: ProxyNode[]): ProxyNode[] {
  return nodes.filter((n) => !FILTER_REGEX.test(n.name));
}

export function deduplicateNodes(nodes: ProxyNode[]): ProxyNode[] {
  const seen = new Set<string>();
  return nodes.filter((n) => {
    if (seen.has(n.name)) return false;
    seen.add(n.name);
    return true;
  });
}

export function nodesToClashYaml(nodes: ProxyNode[]): string {
  return yaml.dump({ proxies: nodes }, { lineWidth: -1, noRefs: true });
}

export function nodesToBase64(nodes: ProxyNode[]): string {
  const uris = nodes.map(nodeToUri).filter(Boolean);
  return btoa(uris.join('\n'));
}

function nodeToUri(node: ProxyNode): string | null {
  switch (node.type) {
    case 'vless':
      return vlessToUri(node);
    case 'vmess':
      return vmessToUri(node);
    case 'ss':
      return ssToUri(node);
    case 'trojan':
      return trojanToUri(node);
    case 'tuic':
      return tuicToUri(node);
    case 'hysteria2':
    case 'hy2':
      return hy2ToUri(node);
    default:
      return null;
  }
}

function buildQuery(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(
    (e): e is [string, string] => e[1] !== undefined && e[1] !== ''
  );
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function vlessToUri(n: ProxyNode): string {
  const uuid = n.uuid as string;
  const flow = n.flow as string | undefined;
  const network = (n.network as string) || 'tcp';
  const fp = n['client-fingerprint'] as string | undefined;

  let security = 'none';
  if (n.tls) security = 'tls';
  if (n['reality-opts']) security = 'reality';

  const params: Record<string, string | undefined> = {
    encryption: 'none',
    type: network,
    security,
    flow,
    fp,
  };

  if (security === 'tls') {
    params.sni = (n.servername || n.sni) as string | undefined;
    if (n['skip-cert-verify']) params.allowInsecure = '1';
  }

  if (security === 'reality') {
    const ro = n['reality-opts'] as Record<string, unknown>;
    params.pbk = ro['public-key'] as string;
    params.sid = (ro['short-id'] as string) || '';
    params.sni = (n.servername || n.sni) as string | undefined;
    params.fp = fp || 'chrome';
  }

  if (network === 'ws') {
    const wo = (n['ws-opts'] || {}) as Record<string, unknown>;
    params.path = wo.path as string | undefined;
    const headers = wo.headers as Record<string, string> | undefined;
    if (headers?.Host) params.host = headers.Host;
  } else if (network === 'grpc') {
    const go = (n['grpc-opts'] || {}) as Record<string, unknown>;
    params.serviceName = go['grpc-service-name'] as string | undefined;
  }

  const query = buildQuery(params);
  return `vless://${uuid}@${n.server}:${n.port}${query}#${encodeURIComponent(n.name)}`;
}

function vmessToUri(n: ProxyNode): string {
  const network = (n.network as string) || 'tcp';
  const obj: Record<string, string> = {
    v: '2',
    ps: n.name,
    add: n.server,
    port: String(n.port),
    id: n.uuid as string,
    aid: String((n.alterId as number) || 0),
    scy: (n.cipher as string) || 'auto',
    net: network,
    type: 'none',
    host: '',
    path: '',
    tls: n.tls ? 'tls' : '',
    sni: ((n.servername || n.sni) as string) || '',
  };

  if (network === 'ws') {
    const wo = (n['ws-opts'] || {}) as Record<string, unknown>;
    obj.path = (wo.path as string) || '';
    const headers = wo.headers as Record<string, string> | undefined;
    if (headers?.Host) obj.host = headers.Host;
  } else if (network === 'h2') {
    const ho = (n['h2-opts'] || {}) as Record<string, unknown>;
    obj.path = (ho.path as string) || '';
    const hosts = ho.host as string[] | undefined;
    if (hosts?.length) obj.host = hosts[0];
  } else if (network === 'grpc') {
    const go = (n['grpc-opts'] || {}) as Record<string, unknown>;
    obj.path = (go['grpc-service-name'] as string) || '';
  }

  return `vmess://${btoa(JSON.stringify(obj))}`;
}

function ssToUri(n: ProxyNode): string {
  const method = n.cipher as string;
  const password = n.password as string;
  const userinfo = btoa(`${method}:${password}`);
  return `ss://${userinfo}@${n.server}:${n.port}#${encodeURIComponent(n.name)}`;
}

function trojanToUri(n: ProxyNode): string {
  const password = n.password as string;
  const network = (n.network as string) || 'tcp';

  const params: Record<string, string | undefined> = {
    security: n.tls === false ? 'none' : 'tls',
    type: network,
    sni: (n.sni || n.servername) as string | undefined,
  };

  if (n['skip-cert-verify']) params.allowInsecure = '1';
  if (n['client-fingerprint']) params.fp = n['client-fingerprint'] as string;

  if (network === 'ws') {
    const wo = (n['ws-opts'] || {}) as Record<string, unknown>;
    params.path = wo.path as string | undefined;
    const headers = wo.headers as Record<string, string> | undefined;
    if (headers?.Host) params.host = headers.Host;
  } else if (network === 'grpc') {
    const go = (n['grpc-opts'] || {}) as Record<string, unknown>;
    params.serviceName = go['grpc-service-name'] as string | undefined;
  }

  const query = buildQuery(params);
  return `trojan://${encodeURIComponent(password)}@${n.server}:${n.port}${query}#${encodeURIComponent(n.name)}`;
}

function tuicToUri(n: ProxyNode): string {
  const uuid = n.uuid as string;
  const password = n.password as string;
  const cc = (n['congestion-controller'] as string) || 'bbr';
  const relay = (n['udp-relay-mode'] as string) || 'native';
  const alpn = Array.isArray(n.alpn) ? (n.alpn as string[]).join(',') : undefined;

  const params: Record<string, string | undefined> = {
    congestion_control: cc,
    udp_relay_mode: relay,
    alpn,
  };
  if (n['skip-cert-verify']) params.allow_insecure = '1';
  if (n.sni) params.sni = n.sni as string;

  const query = buildQuery(params);
  return `tuic://${uuid}:${password}@${n.server}:${n.port}${query}#${encodeURIComponent(n.name)}`;
}

function hy2ToUri(n: ProxyNode): string {
  const password = (n.password || n.auth) as string;
  const params: Record<string, string | undefined> = {
    sni: (n.sni || n.servername) as string | undefined,
  };
  if (n['skip-cert-verify']) params.insecure = '1';
  if (n.obfs) params.obfs = n.obfs as string;
  if (n['obfs-password']) params['obfs-password'] = n['obfs-password'] as string;

  const query = buildQuery(params);
  return `hysteria2://${encodeURIComponent(password)}@${n.server}:${n.port}${query}#${encodeURIComponent(n.name)}`;
}
