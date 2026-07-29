import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts/staging-smoke.mjs');
const expectedStagingUrl =
  'https://clash-sub-hub-staging.guoyingwei6.workers.dev';
const expectedProviderUrl =
  'https://clash-sub-hub-staging-provider.guoyingwei6.workers.dev/provider.yaml';
const fakeAdminPassword = 'fixture-admin-password-not-a-secret';
const fakeMirrorSecret = 'fixture-mirror-secret-not-a-secret';

function runWithTargets(
  stagingUrl: string,
  providerUrl: string
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLASH_SUB_HUB_URL: stagingUrl,
      STAGING_PROVIDER_URL: providerUrl,
      ADMIN_PASSWORD: fakeAdminPassword,
      MIRROR_UPLOAD_SECRET: fakeMirrorSecret,
      MIHOMO_BIN: '/tmp/fixture-mihomo',
    },
  });
}

describe('staging smoke target guard', () => {
  it('rejects a deceptive main Worker hostname before sending credentials', () => {
    const result = runWithTargets(
      'https://clash-sub-hub-staging.attacker.example',
      expectedProviderUrl
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('精确白名单');
    expect(`${result.stdout}${result.stderr}`).not.toContain(fakeAdminPassword);
    expect(`${result.stdout}${result.stderr}`).not.toContain(fakeMirrorSecret);
  });

  it('rejects a deceptive Provider hostname', () => {
    const result = runWithTargets(
      expectedStagingUrl,
      'https://clash-sub-hub-staging-provider.attacker.example/provider.yaml'
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('精确白名单');
  });
});
