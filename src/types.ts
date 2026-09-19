export type DeploymentEnvironment = 'production' | 'staging';

export interface Env {
  KV: KVNamespace;
  ADMIN_PASSWORD: string;
  MIRROR_UPLOAD_SECRET?: string;
  DEPLOYMENT_ENVIRONMENT?: DeploymentEnvironment;
}

export interface User {
  id?: string;
  token?: string;           // legacy only; rotate to remove
  tokenHash?: string;
  tokenPrefix?: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  allowedUpstreams?: string[] | null;   // null/undefined = 全部, [] = 无
  allowedCustomNodes?: string[] | null; // null/undefined = 全部, [] = 无
  filterNodes?: boolean | null;         // null/undefined = 跟随全局, true/false = 强制
  allowProviderMode?: boolean;          // high risk: exposes upstream URLs
}

export interface Upstream {
  name: string;
  url: string;
  userAgent: string;
  exclude?: string;         // 排除关键词（正则）
  prefix?: string;          // 自定义前缀，空字符串=不加前缀，undefined=用名称
  localFetch?: boolean;     // true=本地拉取模式（proxy-provider），CF不拉取
  lastUpdate: string | null;
  nodeCount: number;
  lastError: string | null;
  usage?: UpstreamUsage | null;
}

export interface GlobalSettings {
  defaultUA: string;
  fetchTimeout: number;     // 秒
  filterEnabled: boolean;   // 全局过滤开关
}

export interface UpstreamRuntimeState {
  upstreamId: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  cacheUpdatedAt: string | null;
  nodeCount: number;
  lastError: string | null;
  consecutiveFailures: number;
  nextRetryAt: string | null;
  sourceFingerprint: string;
  usage?: UpstreamUsage | null;
}

export interface CachedUpstream {
  schemaVersion: 1;
  upstreamId: string;
  sourceFingerprint: string;
  updatedAt: string;
  nodeCount: number;
  content: string;
  usage?: UpstreamUsage | null;
}

export interface UpstreamUsage {
  upload?: number;
  download?: number;
  total?: number;
  expire?: number; // unix seconds
}

export interface ProxyNode {
  name: string;
  type: string;
  server: string;
  port: number;
  [key: string]: unknown;
}
