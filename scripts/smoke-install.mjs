/* T4.1 冒烟：干净目录全局安装 tarball，验证 bin 可执行。运行后删除自身与 tarball。 */
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'concertoai-smoke-'));
const tgz = readdirSync('.').find((f) => f.endsWith('.tgz'));
if (tgz === undefined) {
  throw new Error('未找到 tarball');
}

console.log(`安装到: ${dir}`);
execSync(`npm install -g --prefix "${dir}" "${tgz}"`, { stdio: 'inherit' });

const bin = path.join(dir, 'concertoai');
console.log('--- concertoai --version ---');
console.log(execSync(`"${bin}" --version`).toString());
console.log('--- concertoai --help ---');
console.log(execSync(`"${bin}" --help`).toString());

rmSync(dir, { recursive: true, force: true });
unlinkSync(tgz);
console.log('冒烟通过，已清理临时目录与 tarball');
