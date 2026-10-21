import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pool, initAccountStore } from '../apps/bridge/services/accountStore.js';
import {
  initConversationStore, createConversation, getConversation, deleteConversation, listConversationMessages,
  createConversationTurn, getConversationTurn
} from '../apps/bridge/services/conversationStore.js';
import { recoverableConversationTurns, closeConversationTurnStore } from '../apps/worker/services/conversationTurns.js';

const createdUserIds = [];
after(async () => {
  if (createdUserIds.length) await pool.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [createdUserIds]).catch(() => {});
  await closeConversationTurnStore().catch(() => {});
  await pool.end().catch(() => {});
});

test('chat persistence enforces account ownership and idempotent retries', async () => {
  await initAccountStore();
  await initConversationStore();
  const first = await pool.query(
    "INSERT INTO app_users(username,password_hash) VALUES($1,'test-only') RETURNING id",
    [`chat-test-a-${randomUUID()}`]
  );
  const second = await pool.query(
    "INSERT INTO app_users(username,password_hash) VALUES($1,'test-only') RETURNING id",
    [`chat-test-b-${randomUUID()}`]
  );
  const userA = first.rows[0].id;
  const userB = second.rows[0].id;
  createdUserIds.push(userA, userB);

  const chat = await createConversation(userA, 'Prueba de persistencia');
  assert.ok(chat.id);
  assert.equal(await getConversation(userB, chat.id), null, 'another account must not read chat metadata');

  const idempotencyKey = randomUUID();
  const created = await createConversationTurn(userA, chat.id, 'Mensaje de prueba', idempotencyKey);
  const retried = await createConversationTurn(userA, chat.id, 'Mensaje de prueba', idempotencyKey);
  assert.equal(created.turn.id, retried.turn.id, 'retry must reuse the original turn');
  assert.equal(retried.duplicate, true);
  assert.equal(await getConversationTurn(userB, chat.id, created.turn.id), null, 'another account must not read turn status');

  const ownMessages = await listConversationMessages(userA, chat.id, { limit: 20 });
  const foreignMessages = await listConversationMessages(userB, chat.id, { limit: 20 });
  assert.equal(ownMessages.length, 1, 'retry must not duplicate the user message');
  assert.equal(ownMessages[0].content, 'Mensaje de prueba');
  assert.equal(ownMessages[0].metadata.turnId, created.turn.id, 'persist the turn reference for reconnect recovery');
  assert.deepEqual(foreignMessages, []);
  assert.equal(await deleteConversation(userB, chat.id), null, 'another account must not delete this chat');
  const deleted = await deleteConversation(userA, chat.id);
  assert.equal(deleted.id, chat.id);
  assert.equal(await getConversation(userA, chat.id), null, 'deleted chat metadata must be gone');
  const remainingMessages = await pool.query('SELECT count(*)::int AS count FROM conversation_messages WHERE conversation_id=$1', [chat.id]);
  const remainingTurns = await pool.query('SELECT count(*)::int AS count FROM conversation_turns WHERE conversation_id=$1', [chat.id]);
  assert.equal(remainingMessages.rows[0].count, 0, 'messages must cascade-delete with the chat');
  assert.equal(remainingTurns.rows[0].count, 0, 'turn records must cascade-delete with the chat');
});

test('pending/running chat turns are recoverable after a Worker restart', async () => {
  await initAccountStore();
  await initConversationStore();
  const user = await pool.query(
    "INSERT INTO app_users(username,password_hash) VALUES($1,'test-only') RETURNING id",
    [`chat-recovery-${randomUUID()}`]
  );
  const userId = user.rows[0].id;
  createdUserIds.push(userId);
  const chat = await createConversation(userId, 'Recuperación');
  const result = await createConversationTurn(userId, chat.id, 'Persistí antes de responder', randomUUID());
  await pool.query("UPDATE conversation_turns SET status='running', started_at=now() WHERE id=$1", [result.turn.id]);

  const recovered = await recoverableConversationTurns();
  assert.ok(recovered.some(turn => turn.id === result.turn.id), 'recovery should re-enqueue the interrupted turn');
  const status = await getConversationTurn(userId, chat.id, result.turn.id);
  assert.equal(status.status, 'pending', 'recovery should reset interrupted work to a retryable state');
});

test('the web client keeps chats separate from task history and polls durable turn state', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../apps/web/public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/public/app.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /id="open-chats-menu"[^>]*>Chats<\/button>/);
  assert.match(html, /id="task-history-toggle"[^>]*>◷<\/button>/);
  assert.doesNotMatch(html, /id="open-history-menu"/);
  assert.match(html, /id="new-chat-button"[^>]*>＋ Nueva conversación<\/button>/);
  assert.match(html, /id="chat-thread-view" class="chat-thread hidden"/);
  assert.match(app, /lastMessagePreview/);
  assert.match(app, /showChatConversationView/);
  assert.match(app, /showChatListView/);
  assert.match(app, /\/api\/chats\?/);
  assert.match(app, /\/turns\//);
  assert.match(app, /await loadChatMessages\(\)/);
  assert.match(app, /recoverPendingChatTurns\(chatId\)/);
  assert.match(app, /async function selectTaskFromHistory\(id\)[\s\S]*?closeHistoryDrawer\(\)[\s\S]*?showTaskWorkspace\(\)[\s\S]*?await showDetail\(id\)/);
  assert.match(app, /data-chat-delete/);
  assert.match(app, /method: 'DELETE'/);
  assert.doesNotMatch(app, /archive-chat-button/);
  assert.match(html, /id="delete-chat-button"/);
  assert.match(html, /id="chat-message-send"[^>]*aria-label="Enviar mensaje"[^>]*>↑<\/button>/);
  const css = await readFile(new URL('../apps/web/public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /#chats-drawer \.chat-message-form \.chat-send-icon\s*\{[^}]*position:\s*absolute/s);
});
