import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = process.argv[2] ? resolve(process.argv[2]) : root;
const failures = [];
const version = process.versions.node.split('.').map(Number);
if (version[0] < 22 || (version[0] === 22 && version[1] < 14) || version[0] >= 25) failures.push(`Node.js 需要 22.14.x–24.x，当前为 ${process.versions.node}`);
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (packageJson.packageManager !== 'pnpm@11.25.0') failures.push('packageManager 未锁定为 pnpm@11.25.0');
if (!existsSync(join(root, 'pnpm-lock.yaml'))) failures.push('缺少 pnpm-lock.yaml');
if (!existsSync(join(root, '.node-version'))) failures.push('缺少 .node-version');
if (!existsSync(join(root, '.gitattributes'))) failures.push('缺少 .gitattributes');
if (releaseRoot !== root && existsSync(releaseRoot)) {
  const old = ['124', '222', '193', '198'].join('.');
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const info = statSync(file);
      if (info.isDirectory()) walk(file);
      else if (info.size < 2_000_000 && /\.(?:js|mjs|ts|json|md|yml|yaml|ps1|bat|py|conf|env)$/.test(name) && readFileSync(file, 'utf8').includes(old)) failures.push(`发布包仍含旧服务器地址：${file}`);
    }
  };
  walk(releaseRoot);
}
try { execFileSync('git', ['-C', root, 'diff', '--check'], { stdio: 'pipe' }); } catch { failures.push('Git 空白字符检查失败'); }
if (failures.length) { console.error(failures.map(item => `✗ ${item}`).join('\n')); process.exit(1); }
console.log(`✓ preflight passed: Node ${process.versions.node}, pnpm ${packageJson.packageManager}`);
