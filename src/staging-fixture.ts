import { deploymentEnvironment } from './auth';
import { Env } from './types';

export const STAGING_PROVIDER_PATH = '/__staging/provider.yaml';

const STAGING_PROVIDER_YAML = `proxies:
  - name: "staging fixture server refresh"
    type: socks5
    server: 192.0.2.200
    port: 1080
    udp: true
`;

export function handleStagingProvider(
  path: string,
  method: string,
  env: Env
): Response | null {
  if (path !== STAGING_PROVIDER_PATH) return null;
  if (method !== 'GET' || deploymentEnvironment(env) !== 'staging') {
    return new Response('Not Found', { status: 404 });
  }
  return new Response(STAGING_PROVIDER_YAML, {
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
