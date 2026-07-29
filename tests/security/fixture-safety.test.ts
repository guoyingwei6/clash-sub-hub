import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const allowedNetworks = [
  /^192\.0\.2\.\d+$/,
  /^198\.51\.100\.\d+$/,
  /^203\.0\.113\.\d+$/,
];

describe('fixture safety', () => {
  for (const filename of readdirSync(fixturesDir)) {
    it(`${filename} contains only reserved hosts and obvious fixture credentials`, () => {
      const text = readFileSync(resolve(fixturesDir, filename), 'utf8');

      for (const match of text.matchAll(/https?:\/\/([^/\s"'?#]+)/g)) {
        expect(match[1], `unexpected URL host in ${filename}`).toMatch(/\.invalid$/);
      }

      for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
        expect(
          allowedNetworks.some((pattern) => pattern.test(match[0])),
          `unexpected IPv4 address ${match[0]} in ${filename}`
        ).toBe(true);
      }

      expect(text).not.toMatch(/[?&]token=/i);
      expect(text).not.toMatch(/\b[a-f0-9]{32,}\b/i);
      expect(text).not.toMatch(/[A-Za-z0-9_-]{48,}={0,2}/);
    });
  }
});
