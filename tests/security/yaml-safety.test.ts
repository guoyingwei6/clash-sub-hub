import { describe, expect, it } from 'vitest';
import { parseYaml } from '../../src/yaml';

describe('YAML parser safety', () => {
  it('rejects excessive alias expansion', () => {
    const aliases = Array.from({ length: 60 }, () => '  - *fixture').join('\n');
    const payload = `base: &fixture [one, two, three]\nitems:\n${aliases}\n`;
    expect(() => parseYaml(payload)).toThrow(/alias/i);
  });

  it('rejects duplicate mapping keys', () => {
    expect(() => parseYaml('value: one\nvalue: two\n')).toThrow();
  });
});
