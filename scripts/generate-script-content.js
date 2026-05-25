#!/usr/bin/env node
// 构建预处理：将 ClashVerge-AI-Academic-Enhanced.js 嵌入为 TS 字符串常量
// 这样 /script.js 端点可以直接返回版本控制中的脚本内容，无需依赖 KV

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'ClashVerge-AI-Academic-Enhanced.js');
const dest = path.join(root, 'src', 'generated', 'script-content.ts');

const content = fs.readFileSync(src, 'utf-8');
// JSON.stringify 保证所有特殊字符（包括反引号、${}）都被正确转义
const ts = `// 自动生成 - 请勿手动修改。源文件: ClashVerge-AI-Academic-Enhanced.js
// 由 scripts/generate-script-content.js 在构建时生成
export const builtinScriptContent: string = ${JSON.stringify(content)};
`;

fs.writeFileSync(dest, ts, 'utf-8');
console.log(`[generate-script-content] 已写入 ${path.relative(root, dest)} (${content.length} 字节)`);
