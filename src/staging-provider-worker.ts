const PROVIDER_V1_YAML = `proxies:
  - name: "staging fixture server refresh"
    type: socks5
    server: 192.0.2.200
    port: 1080
    udp: true
`;

const PROVIDER_V2_YAML = `proxies:
  - name: "staging fixture server refreshed v2"
    type: socks5
    server: 192.0.2.201
    port: 2080
    udp: true
`;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/provider.yaml') {
      return new Response('Not Found', { status: 404 });
    }
    const switchAt = Number(url.searchParams.get('switchAt'));
    const useV2 = Number.isSafeInteger(switchAt)
      && switchAt > 0
      && Date.now() >= switchAt;
    return new Response(useV2 ? PROVIDER_V2_YAML : PROVIDER_V1_YAML, {
      headers: {
        'Content-Type': 'text/yaml; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
};
