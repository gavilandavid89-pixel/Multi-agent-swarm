import { readdir, lstat, mkdir, copyFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [inputRoot, workspaceRoot, separator, executable, ...args] = process.argv.slice(2);
if (separator !== '--' || !inputRoot || !workspaceRoot || !executable || !path.isAbsolute(inputRoot) || !path.isAbsolute(workspaceRoot) || !path.isAbsolute(executable)) {
  throw new Error('Invalid sandbox bootstrap arguments.');
}
async function copyTree(source, destination) {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error('Symlinks are not allowed in sandbox input.');
    if (info.isDirectory()) {
      await mkdir(to, { recursive: true, mode: 0o700 });
      await copyTree(from, to);
    } else if (info.isFile()) {
      await copyFile(from, to);
      await chmod(to, 0o600);
    } else {
      throw new Error('Unsupported file type in sandbox input.');
    }
  }
}
await copyTree(inputRoot, workspaceRoot);
const child = spawn(executable, args, {
  cwd: workspaceRoot,
  stdio: 'inherit',
  env: {
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: path.join(workspaceRoot, '.home'),
    LANG: 'C.UTF-8',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    NODE_PATH: '/app/node_modules'
  },
  detached: false
});
child.on('error', error => {
  process.stderr.write('Sandbox process failed to start: ' + String(error.message).slice(0, 500) + '\n');
  process.exitCode = 127;
});
child.on('close', (code, signal) => {
  if (signal) process.exitCode = 128;
  else process.exitCode = Number.isInteger(code) ? code : 1;
});
