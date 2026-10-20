import pg from 'pg';
import { consultarModelo } from './aiProviders.js';
import { withUserProviders } from './userProviders.js';

const { Pool } = pg;
const connectionString = process.env.SWARM_DATABASE_URL || '';
if (!connectionString) throw new Error('Falta SWARM_DATABASE_URL para los chats persistentes del Worker.');
const verifiedConnectionString = connectionString.replace(/([?&])sslmode=require(?=(&|$))/i, '$1sslmode=verify-full');
const local = (() => { try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(connectionString).hostname); } catch { return false; } })();
const pool = new Pool({ connectionString: verifiedConnectionString, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, ssl: local ? false : { rejectUnauthorized: true } });

export async function recoverableConversationTurns() {
  // A Worker restart may leave a turn marked running after the process died.
  await pool.query("UPDATE conversation_turns SET status='pending', started_at=NULL WHERE status='running'");
  const { rows } = await pool.query("SELECT id, conversation_id AS \"conversationId\", user_id AS \"userId\" FROM conversation_turns WHERE status='pending' ORDER BY created_at ASC LIMIT 100");
  return rows;
}

export async function processConversationTurn(turnId) {
  const client = await pool.connect();
  let turn;
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT t.id, t.conversation_id AS "conversationId", t.user_id AS "userId",
              t.user_message_id AS "userMessageId", t.status, c.title
         FROM conversation_turns t JOIN conversations c ON c.id=t.conversation_id
        WHERE t.id=$1 FOR UPDATE OF t`,
      [turnId]
    );
    turn = found.rows[0];
    if (!turn || turn.status === 'completed') { await client.query('COMMIT'); return; }
    if (turn.status === 'running') { await client.query('COMMIT'); return; }
    await client.query("UPDATE conversation_turns SET status='running', started_at=now(), attempt_count=attempt_count+1, last_error=NULL WHERE id=$1", [turnId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
  try {
    const { rows: contextRows } = await pool.query(
      `SELECT role, content FROM conversation_messages
        WHERE conversation_id=$1 AND id <= $2
        ORDER BY id DESC LIMIT 21`,
      [turn.conversationId, turn.userMessageId]
    );
    const history = contextRows.reverse().filter(row => ['user','assistant'].includes(row.role));
    const response = await withUserProviders(turn.userId, () => consultarModelo({
      model: process.env.GEMINI_MODEL_REASONING || process.env.GROQ_MODEL_REASONING || process.env.GEMINI_MODEL_CODING || process.env.GROQ_MODEL_CODING || 'openai/gpt-oss-120b',
      temperature: 0.3,
      maxTokens: 1800,
      messages: [
        { role: 'system', content: 'Sos el asistente de conversación de Swarm. Respondé en español, de forma útil y directa. Este es un chat independiente, no una tarea del comité: no afirmes haber ejecutado acciones que no hiciste y no inventes acceso a archivos o herramientas. Si el usuario quiere ejecutar trabajo multiagente, explicá que debe crear una tarea en el área de tareas.' },
        ...history.map(item => ({ role: item.role, content: item.content }))
      ]
    }));
    const answer = String(response ?? '').trim();
    if (!answer) throw new Error('El proveedor de IA devolvió una respuesta vacía.');
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const current = await db.query('SELECT status FROM conversation_turns WHERE id=$1 FOR UPDATE', [turnId]);
      if (current.rows[0]?.status !== 'completed') {
        const inserted = await db.query(
          `INSERT INTO conversation_messages(conversation_id, role, content, metadata)
           VALUES($1, 'assistant', $2, $3::jsonb) RETURNING id`,
          [turn.conversationId, answer.slice(0, 100000), JSON.stringify({ turnId })]
        );
        await db.query(
          `UPDATE conversation_turns SET status='completed', assistant_message_id=$2, finished_at=now(), last_error=NULL WHERE id=$1`,
          [turnId, inserted.rows[0].id]
        );
        await db.query(
          `UPDATE conversation_messages SET metadata=metadata || '{"turnStatus":"completed"}'::jsonb WHERE id=$1`,
          [turn.userMessageId]
        );
        await db.query(
          `UPDATE conversations SET updated_at=now(), last_message_at=now(),
             title=CASE WHEN title='Nuevo chat' THEN left((SELECT content FROM conversation_messages WHERE id=$1), 80) ELSE title END
           WHERE id=$2`,
          [turn.userMessageId, turn.conversationId]
        );
      }
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
    finally { db.release(); }
  } catch (error) {
    const safeMessage = String(error?.message || 'Fallo del proveedor').replace(/[\r\n\t]+/g, ' ').slice(0, 500);
    await pool.query(
      `UPDATE conversation_turns SET status='failed', last_error=$2, finished_at=now()
        WHERE id=$1 AND status <> 'completed'`,
      [turnId, safeMessage]
    );
    await pool.query(
      `UPDATE conversation_messages SET metadata=metadata || jsonb_build_object('turnStatus','failed')
        WHERE id=(SELECT user_message_id FROM conversation_turns WHERE id=$1)`,
      [turnId]
    );
    throw error;
  }
}

export async function closeConversationTurnStore() { await pool.end(); }

export async function hasConversationTurn(turnId, conversationId, userId) {
  const { rows } = await pool.query(
    'SELECT id FROM conversation_turns WHERE id=$1 AND conversation_id=$2 AND user_id=$3',
    [turnId, conversationId, userId]
  );
  return Boolean(rows[0]);
}
