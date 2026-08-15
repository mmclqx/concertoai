import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const tsc = 'C:/tmp/ts7/node_modules/typescript/bin/tsc';
const dir = 'C:/tmp/ts7';
fs.writeFileSync(path.join(dir, 'index.ts'), 'export const test: number = 1;\n');

const run = (label, cfg) => {
  if (cfg === null) {
    fs.rmSync(path.join(dir, 'tsconfig.json'), { force: true });
  } else {
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(cfg, null, 2));
  }
  try {
    execSync(`${process.execPath} ${tsc} --noEmit`, { cwd: dir, encoding: 'utf8' });
    console.log(`${label}: PASS`);
  } catch (e) {
    console.log(`${label}: FAIL exit ${e.status}`);
    console.log((e.stdout ?? '').trim().split('\n').slice(0, 4).join('\n'));
  }
};

const base = { compilerOptions: { target: 'esnext', module: 'nodenext', moduleResolution: 'nodenext', strict: true, noEmit: true, skipLibCheck: true }, include: ['**/*.ts'] };

run('TS7 + current cfg (verbatim)', { ...base, compilerOptions: { ...base.compilerOptions, verbatimModuleSyntax: true } });
run('TS7 + no-verbatim', base);
run('TS7 + no tsconfig (P0-C help)', null);
