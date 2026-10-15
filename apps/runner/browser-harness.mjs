import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '/app/node_modules/playwright/index.mjs';

const root = process.cwd();
const entry = String(process.argv[2] || 'index.html');
if (entry.startsWith('/') || entry.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Invalid entry path');
await stat(path.join(root, entry));
const errors = [];
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '') || entry;
    if (pathname.split('/').some(part => part === '..' || part === '.')) { res.writeHead(400).end(); return; }
    const file = path.join(root, pathname);
    const info = await stat(file);
    if (!info.isFile()) { res.writeHead(404).end(); return; }
    const ext = path.extname(file).toLowerCase();
    const types = { '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(4173, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: false, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--disable-sync'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => errors.push('JavaScript: ' + String(error.message).slice(0, 500)));
  page.on('console', message => { if (message.type() === 'error') errors.push('Console: ' + message.text().slice(0, 500)); });
  page.on('requestfailed', request => errors.push('Request failed: ' + request.url().slice(0, 300) + ' — ' + String(request.failure()?.errorText || 'unknown').slice(0, 200)));
  const response = await page.goto('http://127.0.0.1:4173/' + entry.split('/').map(encodeURIComponent).join('/'), { waitUntil: 'load', timeout: 12000 });
  await page.waitForTimeout(400);
  const result = await page.evaluate(() => ({ title: document.title, bodyText: (document.body?.innerText || '').slice(0, 2500), bodyChildren: document.body?.children.length || 0 }));
  const failed = !response?.ok() || result.bodyChildren === 0 || errors.length > 0;
  console.log(JSON.stringify({ browser: 'Chromium under Xvfb', status: failed ? 'failed' : 'passed', httpStatus: response?.status() ?? null, ...result, errors: errors.slice(0, 30) }));
  if (failed) process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
}
