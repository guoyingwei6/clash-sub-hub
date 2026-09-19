const TOKEN_BYTES = 32;
const PREFIX_LENGTH = 8;
const MIN_CUSTOM_TOKEN_LEN = 16;
const MAX_CUSTOM_TOKEN_LEN = 128;
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

export interface IssuedToken {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
}

export async function issueSubscriptionToken(customToken?: string): Promise<IssuedToken> {
  if (customToken !== undefined) {
    const token = customToken.trim();
    validateCustomToken(token);
    return {
      token,
      tokenHash: await hashSubscriptionToken(token),
      tokenPrefix: token.slice(0, PREFIX_LENGTH),
    };
  }
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  const token = bytesToBase64Url(bytes);
  return {
    token,
    tokenHash: await hashSubscriptionToken(token),
    tokenPrefix: token.slice(0, PREFIX_LENGTH),
  };
}

export function validateCustomToken(token: string): void {
  if (token.length < MIN_CUSTOM_TOKEN_LEN) {
    throw new TokenValidationError(`自定义链接至少 ${MIN_CUSTOM_TOKEN_LEN} 位`);
  }
  if (token.length > MAX_CUSTOM_TOKEN_LEN) {
    throw new TokenValidationError(`自定义链接最长 ${MAX_CUSTOM_TOKEN_LEN} 位`);
  }
  if (!TOKEN_RE.test(token)) {
    throw new TokenValidationError('链接只能包含字母、数字、-、_');
  }
}

export class TokenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenValidationError';
  }
}

export async function hashSubscriptionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export async function legacyUserId(token: string): Promise<string> {
  return `usr_${(await hashSubscriptionToken(token)).slice(0, 16)}`;
}

export function newUserId(): string {
  return `usr_${crypto.randomUUID()}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
