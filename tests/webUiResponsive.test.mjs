import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

class FakeClassList {
  constructor(initial = []) { this.values = new Set(initial); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const shouldAdd = force === undefined ? !this.values.has(value) : Boolean(force);
    if (shouldAdd) this.values.add(value); else this.values.delete(value);
    return shouldAdd;
  }
}

function mountInviteGate(fetchResponse, search = '') {
  const elements = new Map();
  const initiallyHidden = new Set(['register-form', 'access-form', 'key-access-form', 'show-login', 'show-key-login', 'show-register']);
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          id, value: '', textContent: '', disabled: false, listeners: {},
          classList: new FakeClassList(initiallyHidden.has(id) ? ['hidden'] : []),
          addEventListener(type, callback) {
            (this.listeners[type] ||= []).push(callback);
          },
          focus() {},
          requestSubmit() {
            for (const callback of this.listeners.submit || []) callback({ preventDefault() {} });
          },
          setAttribute() {}
        });
      }
      return elements.get(id);
    }
  };
  const context = {
    document,
    URLSearchParams,
    location: { search },
    fetch: async () => fetchResponse
  };
  vm.runInNewContext(read('../apps/web/public/invite-gate.js'), context, { timeout: 1000 });
  return {
    elements,
    async fire(id, type, event = {}) {
      const target = elements.get(id);
      for (const callback of target.listeners[type] || []) await callback({ preventDefault() {}, ...event });
    }
  };
}

test('invite screen keeps login as an explicit alternative without switching after invalid invite', async () => {
  const app = mountInviteGate({
    ok: false,
    status: 400,
    json: async () => ({ valid: false, error: 'La invitación no es válida.' })
  });
  const get = id => app.elements.get(id);
  get('register-invite').value = 'x'.repeat(32);

  assert.equal(get('invite-gate-form').classList.contains('hidden'), false);
  assert.equal(get('show-login').classList.contains('hidden'), false);
  assert.equal(get('show-key-login').classList.contains('hidden'), true);

  await app.fire('invite-gate-form', 'submit');

  assert.equal(get('invite-gate-form').classList.contains('hidden'), false);
  assert.equal(get('access-form').classList.contains('hidden'), true);
  assert.equal(get('show-login').classList.contains('hidden'), false);
  assert.equal(get('show-key-login').classList.contains('hidden'), true);
  assert.match(get('register-status').textContent, /invitación no es válida/i);

  await app.fire('show-login', 'click');
  assert.equal(get('invite-gate-form').classList.contains('hidden'), true);
  assert.equal(get('access-form').classList.contains('hidden'), false);
  assert.equal(get('show-key-login').classList.contains('hidden'), false);
});

test('valid invite opens registration and hides the login alternative during signup', async () => {
  const app = mountInviteGate({
    ok: true,
    status: 200,
    json: async () => ({ valid: true })
  });
  const get = id => app.elements.get(id);
  get('register-invite').value = 'valid-invite-code-'.repeat(2);

  await app.fire('invite-gate-form', 'submit');

  assert.equal(get('invite-gate-form').classList.contains('hidden'), true);
  assert.equal(get('register-form').classList.contains('hidden'), false);
  assert.equal(get('show-login').classList.contains('hidden'), true);
  assert.equal(get('show-key-login').classList.contains('hidden'), true);
});

test('authenticated workspace locks the page and scrolls only chat content on portrait and landscape', () => {
  const css = read('../apps/web/public/styles.css');
  const html = read('../apps/web/public/index.html');
  assert.match(css, /body:not\(\.auth-gate\)\s*\{[^}]*overflow:hidden/s);
  assert.match(css, /body:not\(\.auth-gate\)\s+#conversation\s*\{[^}]*overflow-y:auto/s);
  assert.match(css, /@media\(orientation:landscape\) and \(max-height:520px\)/);
  assert.match(css, /@media\(max-width:700px\)/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /id="copy-account-code"/);
});

test('repairing a missing account code preserves an existing encrypted access key', () => {
  const source = read('../apps/bridge/services/accountStore.js');
  const start = source.indexOf('export async function ensureAccountKey');
  const end = source.indexOf('export async function loginWithAccountKey', start);
  assert.ok(start >= 0 && end > start, 'ensureAccountKey must exist');
  const ensure = source.slice(start, end);
  assert.match(ensure, /if \(keyHash && encryptedKey\)/);
  assert.match(ensure, /const accessKey = decryptSecret\(encryptedKey\)/);
  assert.match(ensure, /UPDATE app_users SET account_code=\$2 WHERE id=\$1/);
  assert.doesNotMatch(ensure, /if \(!accountCode \|\| !keyHash \|\| !encryptedKey\)/);
});


test('floating preview and touch menus have independent window and scroll behavior', () => {
  const css = read('../apps/web/public/styles.css');
  const app = read('../apps/web/public/app.js');
  assert.match(css, /\.artifact-preview\.preview-window\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /touch-action:\s*pan-y/);
  assert.match(app, /initFloatingArtifactPreview/);
  assert.match(app, /Minimizar vista previa/);
  assert.match(app, /Pantalla completa/);
  assert.match(app, /preview-window-launcher/);
});
