import { describe, expect, it } from 'vitest';
import {
  hashSubscriptionToken,
  issueSubscriptionToken,
  legacyUserId,
} from '../../src/domain/token';

describe('subscription tokens', () => {
  it('issues 256-bit URL-safe tokens and stores only their hashes', async () => {
    const first = await issueSubscriptionToken();
    const second = await issueSubscriptionToken();

    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.tokenHash).toBe(await hashSubscriptionToken(first.token));
    expect(first.tokenPrefix).toBe(first.token.slice(0, 8));
    expect(first.tokenHash).not.toContain(first.token);
  });

  it('derives a stable non-secret identifier for legacy users', async () => {
    const first = await legacyUserId('fixture-legacy-token');
    const second = await legacyUserId('fixture-legacy-token');
    expect(first).toBe(second);
    expect(first).toMatch(/^usr_[a-f0-9]{16}$/);
    expect(first).not.toContain('fixture-legacy-token');
  });
});
