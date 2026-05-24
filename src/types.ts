export interface Env {
  KV: KVNamespace;
  ADMIN_PASSWORD: string;
}

export interface User {
  token: string;
  name: string;
  enabled: boolean;
  createdAt: string;
}

export interface Upstream {
  name: string;
  url: string;
  userAgent: string;
  lastUpdate: string | null;
  nodeCount: number;
  lastError: string | null;
}

export interface ProxyNode {
  name: string;
  type: string;
  server: string;
  port: number;
  [key: string]: unknown;
}
