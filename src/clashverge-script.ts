// The script is maintained as Clash Verge-compatible JavaScript outside the TS source tree.
// @ts-ignore: the worker bundle can import this JS module, but TypeScript has no declaration for it.
import { main as rawMain } from '../ClashVerge-AI-Academic-Enhanced.js';

export function runBuiltinScript(config: Record<string, unknown>): Record<string, unknown> {
  const result = rawMain(config);
  return result && typeof result === 'object' ? result : config;
}
