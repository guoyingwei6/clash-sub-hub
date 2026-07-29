#!/usr/bin/env node
// Build the admin page's browser dependencies into same-origin Worker assets.
// No third-party script is loaded while an administrator token is in memory.

const fs = require('fs');
const path = require('path');
const postcss = require('postcss');
const tailwindcss = require('tailwindcss');

const root = path.resolve(__dirname, '..');
const uiPath = path.join(root, 'src', 'ui.html');
const generatedDir = path.join(root, 'src', 'generated');
const destination = path.join(generatedDir, 'admin-assets.ts');

async function main() {
  const tailwind = await postcss([
    tailwindcss({
      content: [uiPath],
      theme: { extend: {} },
      plugins: [],
    }),
  ]).process('@tailwind base;@tailwind components;@tailwind utilities;', {
    from: undefined,
  });

  const codeMirrorCss = [
    require.resolve('codemirror/lib/codemirror.css'),
    require.resolve('codemirror/theme/dracula.css'),
  ].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const codeMirrorJs = [
    require.resolve('codemirror/lib/codemirror.js'),
    require.resolve('codemirror/mode/javascript/javascript.js'),
  ].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const css = `${tailwind.css}\n${codeMirrorCss}`;

  const output = `// 自动生成 - 请勿手动修改。
// 由 scripts/generate-admin-assets.js 在构建时生成。
export const adminCss: string = ${JSON.stringify(css)};
export const codeMirrorJs: string = ${JSON.stringify(codeMirrorJs)};
`;
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(destination, output, 'utf8');
  console.log(
    `[generate-admin-assets] 已写入 ${path.relative(root, destination)} `
    + `(CSS ${css.length} 字节, JS ${codeMirrorJs.length} 字节)`
  );
}

main().catch((error) => {
  console.error('[generate-admin-assets] 构建失败');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
