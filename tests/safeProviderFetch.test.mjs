import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicProviderAddress, safeProviderFetch } from '../apps/worker/services/safeProviderFetch.js';

test('custom provider transport rejects private and reserved IP ranges', () => {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.20.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1'
  ]) assert.equal(isPublicProviderAddress(address), false, `${address} must not be treated as public`);

  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicProviderAddress(address), true, `${address} is a public address`);
  }
});

test('custom provider transport refuses local, non-HTTPS, and non-standard-port targets before connecting', async () => {
  await assert.rejects(safeProviderFetch('https://127.0.0.1/v1/models'), /dominio público HTTPS/i);
  await assert.rejects(safeProviderFetch('https://metadata.google.internal/models'), /dominio público HTTPS/i);
  await assert.rejects(safeProviderFetch('http://api.custom-provider.example.com/v1/models'), /dominio público HTTPS/i);
  await assert.rejects(safeProviderFetch('https://api.custom-provider.example.com:8443/v1/models'), /dominio público HTTPS/i);
});
