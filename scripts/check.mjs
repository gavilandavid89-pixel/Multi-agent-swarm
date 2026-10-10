import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const scan = dir => readdirSync(dir).flatMap(name => { const file = path.join(dir, name); if (statSync(file).isDirectory()) return scan(file); return file.endsWith('.js') || file.endsWith('.mjs') ? [file] : []; });
const files = [...scan(path.join(root, 'apps'))];
let failed = false;
for (const file of files) { const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }); if (result.status !== 0) { failed = true; process.stderr.write(`FAIL ${path.relative(root, file)}\n${result.stderr}`); } else process.stdout.write(`OK   ${path.relative(root, file)}\n`); }
if (failed) process.exitCode = 1; else process.stdout.write(`\nSintaxis válida en ${files.length} archivos JavaScript. (No reemplaza pruebas de integración con proveedores reales.)\n`);
