import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts/real-staging-sync.mjs');
const exactTarget =
  'https://clash-sub-hub-real-staging.guoyingwei6.workers.dev';

function run(overrides: Record<string, string>) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      REAL_STAGING_PREPARE_ONLY: '1',
      ...overrides,
    },
  });
}

describe('real staging target guard', () => {
  it.each([
    'https://clash.guoyingwei.top',
    'https://clash-sub-hub-staging.guoyingwei6.workers.dev',
    'https://clash-sub-hub-real-staging.guoyingwei6.workers.dev.attacker.example',
    'http://clash-sub-hub-real-staging.guoyingwei6.workers.dev',
    `${exactTarget}:8443`,
    `${exactTarget}/other`,
    `${exactTarget}?token=unexpected`,
  ])('rejects non-exact target before reading credentials: %s', (target) => {
    const result = run({ REAL_STAGING_URL: target });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      '目标不是仓库登记的专属 real-staging Worker'
    );
  });
});
