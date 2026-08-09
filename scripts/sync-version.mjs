/* npm version 钩子：把 package.json 的版本同步到 src/version.ts 的 VERSION 常量。 */
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (typeof pkg.version !== 'string') {
  console.error('package.json 缺少 version');
  process.exit(1);
}

const versionPath = 'src/version.ts';
const versionSrc = readFileSync(versionPath, 'utf8');
const updated = versionSrc.replace(
  /export const VERSION = '[^']*';/,
  `export const VERSION = '${pkg.version}';`,
);
if (updated === versionSrc) {
  console.error(`src/version.ts 中未找到 VERSION 常量，无法同步为 ${pkg.version}`);
  process.exit(1);
}
writeFileSync(versionPath, updated);
console.log(`VERSION 已同步为 ${pkg.version}`);
