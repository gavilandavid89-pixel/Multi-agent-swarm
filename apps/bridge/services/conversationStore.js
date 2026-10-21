import { randomUUID } from 'node:crypto';
import { pool } from './accountStore.js';

const MAX_TITLE_LENGTH = 120;

export async function initConversationStore() {
  await pool.query(`CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'Nuevo chat' CHECK (char_length(title) BETWEEN 1 AND 120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at TIMESTAMPTZ,
    last_message_at TIMESTAMPTZ
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS conversations_user_updated_idx ON conversations(user_id, updated_at DESC, id DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS conversations_user_archived_idx ON conversations(user_id, archived_at, updated_at DESC)');
  await pool.query(`CREATE TABLE IF NOT EXISTS conversation_messages (
    id BIGSERIAL PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
    content TEXT NOT NULL CHECK (char_length(content) <= 100000),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_idempotency_idx ON conversation_messages(conversation_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
  await pool.query('CREATE INDEX IF NOT EXISTS conversation_messages_order_idx ON conversation_messages(conversation_id, id)');

  await pool.query(`CREATE TABLE IF NOT EXISTS conversation_turns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    user_message_id BIGINT NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
    assistant_message_id BIGINT REFERENCES conversation_messages(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    UNIQUE(conversation_id, idempotency_key)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS conversation_turns_recovery_idx ON conversation_turns(status, created_at)');
}

function normalizeTitle(value) {
  const title = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!title || title.length > MAX_TITLE_LENGTH) {
    throw Object.assign(new Error('El título debe tener entre 1 y 120 caracteres.'), { status: 400 });
  }
  return title;
}

export async function listConversations(userId, { archived = false, limit = 25, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.created_at AS "createdAt", c.updated_at AS "updatedAt",
            c.archived_at AS "archivedAt", c.last_message_at AS "lastMessageAt",
            (SELECT count(*)::int FROM conversation_messages m WHERE m.conversation_id=c.id) AS "messageCount",
            (SELECT left(m.content, 240) FROM conversation_messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS "lastMessagePreview",
            (SELECT m.role FROM conversation_messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS "lastMessageRole"
       FROM conversations c
      WHERE c.user_id=$1 AND (($2::boolean AND c.archived_at IS NOT NULL) OR (NOT $2::boolean AND c.archived_at IS NULL))
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT $3 OFFSET $4`,
    [userId, archived, limit, offset]
  );
  return rows;
}

export async function createConversation(userId, title = 'Nuevo chat') {
  const safeTitle = normalizeTitle(title);
  const { rows } = await pool.query(
    `INSERT INTO conversations(user_id, title) VALUES($1, $2)
     RETURNING id, title, created_at AS "createdAt", updated_at AS "updatedAt",
               archived_at AS "archivedAt", last_message_at AS "lastMessageAt"`,
    [userId, safeTitle]
  );
  return rows[0];
}

export async function getConversation(userId, conversationId) {
  const { rows } = await pool.query(
    `SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt",
            archived_at AS "archivedAt", last_message_at AS "lastMessageAt"
       FROM conversations WHERE id=$1 AND user_id=$2`,
    [conversationId, userId]
  );
  return rows[0] || null;
}

export async function renameConversation(userId, conversationId, title) {
  const safeTitle = normalizeTitle(title);
  const { rows } = await pool.query(
    `UPDATE conversations SET title=$3, updated_at=now()
      WHERE id=$1 AND user_id=$2 AND archived_at IS NULL
      RETURNING id, title, created_at AS "createdAt", updated_at AS "updatedAt",
                archived_at AS "archivedAt", last_message_at AS "lastMessageAt"`,
    [conversationId, userId, safeTitle]
  );
  return rows[0] || null;
}

export async function setConversationArchived(userId, conversationId, archived) {
  const { rows } = await pool.query(
    `UPDATE conversations SET archived_at=CASE WHEN $3::boolean THEN COALESCE(archived_at, now()) ELSE NULL END,
            updated_at=now()
      WHERE id=$1 AND user_id=$2
      RETURNING id, title, created_at AS "createdAt", updated_at AS "updatedAt",
                archived_at AS "archivedAt", last_message_at AS "lastMessageAt"`,
    [conversationId, userId, archived]
  );
  return rows[0] || null;
}

// Hard-delete only a conversation owned by the requesting account. PostgreSQL
// cascades deletion to its messages and turns, preventing orphaned chat records.
export async function deleteConversation(userId, conversationId) {
  const { rows } = await pool.query(
    'DELETE FROM conversations WHERE id=$1 AND user_id=$2 RETURNING id',
    [conversationId, userId]
  );
  return rows[0] || null;
}

export async function listConversationMessages(userId, conversationId, { limit = 50, beforeId = null } = {}) {
  const { rows } = await pool.query(
    `SELECT m.id, m.role, m.content, m.metadata, m.created_at AS "createdAt"
       FROM conversation_messages m
       JOIN conversations c ON c.id=m.conversation_id
      WHERE c.id=$1 AND c.user_id=$2
        AND ($3::bigint IS NULL OR m.id < $3::bigint)
      ORDER BY m.id DESC
      LIMIT $4`,
    [conversationId, userId, beforeId, limit]
  );
  return rows.reverse();
}

export async function createConversationTurn(userId, conversationId, message, idempotencyKey) {
  const content = typeof message === 'string' ? message.trim() : '';
  if (!content) throw Object.assign(new Error('Escribí un mensaje.'), { status: 400 });
  if (content.length > 6000) throw Object.assign(new Error('El mensaje supera los 6.000 caracteres.'), { status: 413 });
  if (typeof idempotencyKey !== 'string' || !/^[0-9a-f-]{36}$/i.test(idempotencyKey)) {
    throw Object.assign(new Error('Clave de idempotencia inválida.'), { status: 400 });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      'SELECT id FROM conversations WHERE id=$1 AND user_id=$2 AND archived_at IS NULL FOR UPDATE',
      [conversationId, userId]
    );
    if (!owned.rows[0]) {
      await client.query('ROLLBACK');
      return { missing: true };
    }
    const existing = await client.query(
      `SELECT id, status, user_message_id AS "userMessageId", assistant_message_id AS "assistantMessageId"
         FROM conversation_turns WHERE conversation_id=$1 AND idempotency_key=$2`,
      [conversationId, idempotencyKey]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return { turn: existing.rows[0], duplicate: true };
    }
    const turnId = randomUUID();
    const userMessage = await client.query(
      `INSERT INTO conversation_messages(conversation_id, role, content, metadata, idempotency_key)
       VALUES($1, 'user', $2, $3::jsonb, $4) RETURNING id`,
      [conversationId, content, JSON.stringify({ turnId, turnStatus: 'pending' }), idempotencyKey]
    );
    const turnResult = await client.query(
      `INSERT INTO conversation_turns(id, conversation_id, user_id, idempotency_key, user_message_id)
       VALUES($1, $2, $3, $4, $5)
       RETURNING id, status, user_message_id AS "userMessageId", assistant_message_id AS "assistantMessageId"`,
      [turnId, conversationId, userId, idempotencyKey, userMessage.rows[0].id]
    );
    await client.query(
      `UPDATE conversations SET updated_at=now(), last_message_at=now(),
         title=CASE WHEN title='Nuevo chat' THEN left($3, 80) ELSE title END
       WHERE id=$1 AND user_id=$2`,
      [conversationId, userId, content]
    );
    await client.query('COMMIT');
    return { turn: turnResult.rows[0], duplicate: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      const existing = await pool.query(
        `SELECT id, status, user_message_id AS "userMessageId", assistant_message_id AS "assistantMessageId"
           FROM conversation_turns WHERE conversation_id=$1 AND idempotency_key=$2`,
        [conversationId, idempotencyKey]
      );
      if (existing.rows[0]) return { turn: existing.rows[0], duplicate: true };
    }
    throw error;
  } finally { client.release(); }
}

export async function getConversationTurn(userId, conversationId, turnId) {
  const { rows } = await pool.query(
    `SELECT id, status, last_error AS "lastError", attempt_count AS "attemptCount",
            user_message_id AS "userMessageId", assistant_message_id AS "assistantMessageId",
            created_at AS "createdAt", finished_at AS "finishedAt"
       FROM conversation_turns
      WHERE id=$1 AND conversation_id=$2 AND user_id=$3`,
    [turnId, conversationId, userId]
  );
  return rows[0] || null;
}
