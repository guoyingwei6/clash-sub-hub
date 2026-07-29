import { parse, stringify } from 'yaml';

const MAX_ALIAS_COUNT = 50;

export function parseYaml<T = unknown>(text: string): T {
  return parse(text, {
    maxAliasCount: MAX_ALIAS_COUNT,
    merge: false,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  }) as T;
}

export function stringifyYaml(value: unknown): string {
  return stringify(value, {
    aliasDuplicateObjects: false,
    lineWidth: 0,
  });
}
