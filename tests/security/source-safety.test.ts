import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('source security guardrails', () => {
  it('does not execute dynamic JavaScript in the Worker source', () => {
    const subscription = readFileSync(resolve(root, 'src/subscription.ts'), 'utf8');
    expect(subscription).not.toMatch(/\bnew\s+Function\b/);
    expect(subscription).not.toMatch(/\beval\s*\(/);
  });

  it('does not accept an administrator password in the URL query', () => {
    const auth = readFileSync(resolve(root, 'src/auth.ts'), 'utf8');
    expect(auth).not.toContain('searchParams');
    expect(auth).not.toMatch(/[?&]key=/);
  });

  it('does not publish the retired private DNS path in the base script', () => {
    const script = readFileSync(
      resolve(root, 'ClashVerge-AI-Academic-Enhanced.js'),
      'utf8'
    );
    expect(script).not.toMatch(/https:\/\/dns\.guoyingwei\.top\//);
  });

  it('self-hosts administrator assets and forbids dynamic data in inline handlers', () => {
    const html = readFileSync(resolve(root, 'src/ui.html'), 'utf8');
    expect(html).not.toMatch(/<(?:script|link)\b[^>]+https?:\/\//i);
    expect(html).not.toMatch(/onclick="[^"]*\$\{/);
    expect(html).not.toMatch(/(?:data-[\w-]+|value|id)="[^"]*\$\{esc\(/);
    expect(html).toContain('data-node-name="${attr(n.name)}"');
    expect(html).not.toContain('admin_key');
    expect(html).toContain("api('/api/admin/session')");

    const index = readFileSync(resolve(root, 'src/index.ts'), 'utf8');
    expect(index).toContain("'Content-Security-Policy'");
    expect(index).toContain("default-src 'self'");
    const auth = readFileSync(resolve(root, 'src/auth.ts'), 'utf8');
    expect(auth).toContain('HttpOnly');
    expect(auth).toContain('SameSite=Strict');
  });

  it('never serves a mutable KV script through the public script endpoint', () => {
    const index = readFileSync(resolve(root, 'src/index.ts'), 'utf8');
    const publicScriptBranch = index.slice(
      index.indexOf("if (path === '/script.js')"),
      index.indexOf("if (path === '/assets/admin.css')")
    );
    expect(publicScriptBranch).toContain('builtinScriptContent');
    expect(publicScriptBranch).not.toContain('env.KV');
  });

  it('keeps the inline admin JavaScript syntactically valid', () => {
    const html = readFileSync(resolve(root, 'src/ui.html'), 'utf8');
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .map((match) => match[1])
      .filter((script) => script.trim());
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(() => new vm.Script(script)).not.toThrow();
  });
});
