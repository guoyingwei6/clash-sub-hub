import { describe, expect, it } from 'vitest';
import { isProxyNode, parseClashYaml } from '../../src/converter';
import { stringifyYaml } from '../../src/yaml';

describe('untrusted provider node validation', () => {
  it('keeps only complete nodes with bounded scalar identity fields', () => {
    const payload = stringifyYaml({
      proxies: [
        {
          name: 'valid fixture',
          type: 'ss',
          server: '192.0.2.90',
          port: 443,
          cipher: 'aes-128-gcm',
          password: 'fixture-password',
        },
        {
          name: { injected: true },
          type: 'ss',
          server: '192.0.2.91',
          port: 443,
        },
        {
          name: 'markup port',
          type: 'ss',
          server: '192.0.2.92',
          port: '443"><img src=x onerror=alert(1)>',
        },
        {
          name: 'missing server',
          type: 'ss',
          port: 443,
        },
      ],
    });

    expect(parseClashYaml(payload).map((node) => node.name)).toEqual(['valid fixture']);
  });

  it('rejects invalid URI ports and malformed node primitives', () => {
    expect(parseClashYaml('vless://fixture@example.invalid:not-a-port#bad')).toEqual([]);
    expect(isProxyNode({
      name: '\"><script>alert(1)</script>',
      type: 'ss',
      server: '192.0.2.93',
      port: 443,
    })).toBe(true);
    expect(isProxyNode({
      name: 'bad',
      type: 'ss',
      server: '192.0.2.93',
      port: 70000,
    })).toBe(false);
  });
});
