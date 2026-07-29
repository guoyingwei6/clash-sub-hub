const RESERVED_PROXY_NAMES = new Set([
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS',
  'COMPATIBLE',
  'GLOBAL',
  '优先自建',
  '⚡️ 自动选择',
  '节点选择',
  '🏠 家宽',
  '🚇 家宽中转',
  '谷歌服务',
  'YouTube',
  '电报消息',
  'AI',
  'TikTok',
  'X(Twitter)',
  '微软服务',
  '苹果服务',
  '邮件',
  '广告过滤',
  '全局直连',
  '全局拦截',
  '漏网之鱼',
]);

export function isReservedProxyName(name: string): boolean {
  return RESERVED_PROXY_NAMES.has(name);
}
