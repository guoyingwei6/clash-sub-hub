import { UpstreamRuntimeState } from '../types';

export const RETRY_BASE_SECONDS = 60;
export const RETRY_MAX_SECONDS = 60 * 60;

export function retryDelaySeconds(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(RETRY_BASE_SECONDS * 2 ** exponent, RETRY_MAX_SECONDS);
}

export function nextRetryAt(now: Date, consecutiveFailures: number): string {
  return new Date(now.getTime() + retryDelaySeconds(consecutiveFailures) * 1000).toISOString();
}

export function canAttemptRefresh(
  state: UpstreamRuntimeState | null,
  now: Date,
  force = false
): boolean {
  if (force || !state?.nextRetryAt) return true;
  return now.getTime() >= Date.parse(state.nextRetryAt);
}

export function cacheAgeSeconds(updatedAt: string, now: Date): number {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
}
