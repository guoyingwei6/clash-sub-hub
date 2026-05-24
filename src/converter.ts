import yaml from 'js-yaml';
import { ProxyNode } from './types';

const FILTER_REGEX = /官网|套餐|流量|异常|剩余|ISP|all|免费|低倍率|0\.[0-9]x|测试|到期/i;

export function parseClashYaml(text: string): ProxyNode[] {
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
