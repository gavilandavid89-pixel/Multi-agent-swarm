import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  pool, initAccountStore, hashPassword, createInvite, registerFromInvite,
  saveApiKeys, listApiKeys, createSession, findSession, decryptSecret,
  changePassword, verifyPassword, listManagedUsers, setManagedUserDisabled
} from '../apps/bridge/services/accountStore.js';
import { withUserProviders, currentUserProviders, closeUserProvidersStore } from '../apps/worker/services/userProviders.js';

test('isolates account APIs, protects saved keys, and enforces single-use invites', async t => {
  t.after(async () => { await closeUserProvidersStore(); await pool.end(); });
  await initAccountStore();

  const suffix = randomUUID().slice(0, 8);
  const adminName = `audit-admin-${suffix}`;
  const adminResult = await pool.query(
    "INSERT INTO app_users(username,password_hash,role) VALUES($1,$2,'admin') RETURNING id",
    [adminName, hashPassword('integration-password-1')]
  );
  const adminId = adminResult.rows[0].id;

  const inviteA = await createInvite(adminId, 1);
  const inviteB = await createInvite(adminId, 1);
  const userA = await registerFromInvite(`audit-user-a-${suffix}`, 'integration-password-a', inviteA.code);
  const userB = await registerFromInvite(`audit-user-b-${suffix}`, 'integration-password-b', inviteB.code);

  await assert.rejects(
    registerFromInvite(`audit-reuse-${suffix}`, 'integration-password-c', inviteA.code),
    /invitación/i
  );

  const raceInvite = await createInvite(adminId, 1);
  const raceResults = await Promise.allSettled([
    registerFromInvite(`audit-race-a-${suffix}`, 'integration-password-d', raceInvite.code),
    registerFromInvite(`audit-race-b-${suffix}`, 'integration-password-e', raceInvite.code)
  ]);
  assert.equal(raceResults.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(raceResults.filter(result => result.status === 'rejected').length, 1);

  const models = { reasoning: 'gpt-4o-mini', coding: 'gpt-4o-mini', validation: 'gpt-4o-mini' };
  await saveApiKeys(userA.id, [{ slot: 1, label: 'Test provider A', baseUrl: 'https://api.openai.com/v1', models, apiKey: 'test-key-alpha' }]);
  await saveApiKeys(userB.id, [{ slot: 1, label: 'Test provider B', baseUrl: 'https://api.openai.com/v1', models, apiKey: 'test-key-beta' }]);

  const apisA = await listApiKeys(userA.id);
  const apisB = await listApiKeys(userB.id);
  assert.deepEqual(apisA.map(api => api.label), ['Test provider A']);
  assert.deepEqual(apisB.map(api => api.label), ['Test provider B']);
  assert.equal(JSON.stringify(apisA).includes('test-key-alpha'), false);
  assert.equal(JSON.stringify(apisB).includes('test-key-beta'), false);

  const managedUsers = await listManagedUsers();
  assert.equal(managedUsers.some(user => user.id === userA.id), true);
  assert.equal(managedUsers.some(user => user.id === userB.id), true);
  assert.equal(managedUsers.some(user => Object.hasOwn(user, 'password_hash')), false);
  await assert.rejects(setManagedUserDisabled(adminId, true), /cuentas administradoras/i);

  const userBToken = await createSession(userB.id);
  const activeProviderContext = await withUserProviders(userB.id, () => currentUserProviders());
  assert.equal(activeProviderContext.providers.length, 1);
  const disabledUser = await setManagedUserDisabled(userB.id, true);
  assert.ok(disabledUser.disabledAt);
  assert.equal(await findSession(userBToken), null, 'disabling a user must revoke existing sessions');
  const disabledProviderContext = await withUserProviders(userB.id, () => currentUserProviders());
  assert.equal(disabledProviderContext.providers.length, 0, 'disabled accounts must not load saved providers');
  assert.equal((await listApiKeys(userB.id)).length, 1, 'disabling must preserve saved API data');
  const reenabledUser = await setManagedUserDisabled(userB.id, false);
  assert.equal(reenabledUser.disabledAt, null);
  assert.equal(await findSession(userBToken), null, 'reactivation must not resurrect revoked sessions');
  const reenabledProviderContext = await withUserProviders(userB.id, () => currentUserProviders());
  assert.equal(reenabledProviderContext.providers.length, 1, 'saved providers can load again after reactivation');

  const encrypted = await pool.query('SELECT encrypted_api_key FROM user_api_keys WHERE user_id=$1 AND slot=1', [userA.id]);
  assert.equal(encrypted.rows.length, 1);
  assert.equal(encrypted.rows[0].encrypted_api_key.includes('test-key-alpha'), false);
  assert.equal(decryptSecret(encrypted.rows[0].encrypted_api_key), 'test-key-alpha');

  const token = await createSession(userA.id);
  const otherToken = await createSession(userA.id);
  assert.equal((await findSession(token)).id, userA.id);
  await assert.rejects(
    changePassword(userA.id, 'incorrect-password', 'new-integration-password-a', token),
    /contraseña actual/i
  );
  assert.equal((await findSession(token)).id, userA.id, 'a failed password change must not revoke the current session');

  const rotatedToken = await changePassword(
    userA.id, 'integration-password-a', 'new-integration-password-a', token
  );
  assert.equal(await findSession(token), null, 'the previous session token must stop working');
  assert.equal(await findSession(otherToken), null, 'other sessions must be revoked after a password change');
  assert.equal((await findSession(rotatedToken)).id, userA.id, 'the returned token must remain active');
  const newPasswordHash = await pool.query('SELECT password_hash FROM app_users WHERE id=$1', [userA.id]);
  assert.equal(verifyPassword('new-integration-password-a', newPasswordHash.rows[0].password_hash), true);
  assert.equal(verifyPassword('integration-password-a', newPasswordHash.rows[0].password_hash), false);
});
