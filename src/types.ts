export interface Env {
  KV: KVNamespace;
  ADMIN_PASSWORD: string;
}

export interface User {
  token: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  allowedUpstreams?: string[] | null;   // null/undefined = 全部, [] = 无
  allowedCustomNodes?: string[] | null; // null/undefined = 全部, [] = 无
  filterNodes?: boolean | null;         // null/undefined = 跟随全局, true/false = 强制
}

export interface Upstream {
  name: string;
  url: string;
  userAgent: string;
  exclude?: string;         // 排除关键词（正则）
  prefix?: string;          // 自定义前缀，空字符串=不加前缀，undefined=用名称
  lastUpdate: string | null;
  nodeCount: number;
  lastError: string | null;
}

export interface GlobalSettings {
  defaultUA: string;
  fetchTimeout: number;     // 秒
  filterEnabled: boolean;   // 全局过滤开关
}

export interface ProxyNode {
  name: string;
  type: string;
  server: string;
  port: number;
  [key: string]: unknown;
}
