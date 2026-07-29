const TOKEN_BYTES = 32;
const PREFIX_LENGTH = 8;

export interface IssuedToken {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
}

export async function issueSubscriptionToken(): Promise<IssuedToken> {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  const token = bytesToBase64Url(bytes);
  return {
    token,
    tokenHash: await hashSubscriptionToken(token),
    tokenPrefix: token.slice(0, PREFIX_LENGTH),
  };
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
