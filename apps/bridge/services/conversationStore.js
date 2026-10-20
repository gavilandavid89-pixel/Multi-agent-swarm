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
}

function normalizeTitle(value) {
  const title = typeof value === 'string' ? value.trim().replace(/\\s+/g, ' ') : '';
  if (!title || title.length > MAX_TITLE_LENGTH) {
    throw Object.assign(new Error('El título debe tener entre 1 y 120 caracteres.'), { status: 400 });
  }
  return title;
}

export async function listConversations(userId, { archived = false, limit = 25, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.created_at AS "createdAt", c.updated_at AS "updatedAt",
            c.archived_at AS "archivedAt", c.last_message_at AS "lastMessageAt",
            (SELECT count(*)::int FROM conversation_messages m WHERE m.conversation_id=c.id) AS "messageCount"
       FROM conversations c
      WHERE c.user_id=$1 AND (($2::boolean AND c.archived_at IS NOT NULL) OR (NOT $2::boolean AND c.archived_at IS NULL))
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT $3 OFFSET $4`,
    [userId, archived, limit, offset]
  );
  return rows;
}

export async function createConversation(userId, title = 'Nuevo chat') {
  const safeTitle = normalizeTitle(title || 'Nuevo chat');
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
