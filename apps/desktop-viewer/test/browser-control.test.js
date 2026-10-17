import test from 'node:test';
import assert from 'node:assert/strict';
import { safePublicUrl, browserToolAction } from '../browser-control.js';

test('accepts public HTTP and HTTPS URLs', () => {
  assert.equal(safePublicUrl('https://example.com/path?q=1'), 'https://example.com/path?q=1');
  assert.equal(safePublicUrl('http://example.org'), 'http://example.org/');
});

test('blocks local, reserved, and credential-bearing URLs', () => {
  for (const url of [
    'file:///etc/passwd',
    'http://localhost:9222/json',
    'http://127.0.0.1:9222',
    'http://10.0.0.1',
    'http://192.168.1.1',
    'http://169.254.169.254/latest/meta-data',
    'http://service.local',
    'http://user:password@example.com'
  ]) assert.throws(() => safePublicUrl(url), { message: /URL|host|credenciales|direcciones/i });
});

test('rejects unknown browser actions without contacting Chromium', async () => {
  await assert.rejects(browserToolAction({ action: 'execute-shell' }), /Acción desconocida/);
});

test('rejects unsupported keys before opening a browser session', async () => {
  await assert.rejects(browserToolAction({ action: 'press', key: 'F12' }), /Tecla no permitida/);
});

test('requires selectors for click and type', async () => {
  await assert.rejects(browserToolAction({ action: 'click' }), /selector CSS/);
  await assert.rejects(browserToolAction({ action: 'type', text: 'hola' }), /selector CSS/);
});

test('caps text input length before opening a browser session', async () => {
  await assert.rejects(browserToolAction({ action: 'type', selector: 'input', text: 'x'.repeat(5001) }), /5000 caracteres/);
});
