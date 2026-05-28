import { Database } from 'bun:sqlite'
import { config } from './config'

export type ChatRecord = {
  chatId: number
  title: string
  type: string
  messageCountSinceTags: number
}

export type MemberRecord = {
  userId: number
  username: string | null
  displayName: string
  messageCount: number
  currentTag: string | null
}

export type MessageRecord = {
  telegramMessageId: number
  userId: number
  displayName: string
  text: string
  createdAt: string
}

const db = new Database(config.DATABASE_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    chat_id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    message_count_since_tags INTEGER NOT NULL DEFAULT 0,
    setup_warning_sent_at TEXT,
    last_tagged_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS members (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT,
    display_name TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    current_tag TEXT,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_tagged_at TEXT,
    PRIMARY KEY (chat_id, user_id),
    FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    telegram_message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    display_name TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS messages_chat_id_id_idx ON messages(chat_id, id);
  CREATE INDEX IF NOT EXISTS members_chat_id_seen_idx ON members(chat_id, last_seen_at);
`)

export function ensureChat(chatId: number, title: string, type: string) {
  db.query(
    `INSERT INTO chats (chat_id, title, type)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       title = excluded.title,
       type = excluded.type,
       updated_at = CURRENT_TIMESTAMP`
  ).run(chatId, title || String(chatId), type)
}

export function getChat(chatId: number): ChatRecord | null {
  const row = db
    .query(
      `SELECT chat_id AS chatId, title, type,
              message_count_since_tags AS messageCountSinceTags
       FROM chats WHERE chat_id = ?`
    )
    .get(chatId) as ChatRecord | null
  return row
}

export function upsertMember(params: {
  chatId: number
  userId: number
  username?: string
  displayName: string
}) {
  db.query(
    `INSERT INTO members (chat_id, user_id, username, display_name, message_count)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET
       username = excluded.username,
       display_name = excluded.display_name,
       message_count = members.message_count + 1,
       last_seen_at = CURRENT_TIMESTAMP`
  ).run(
    params.chatId,
    params.userId,
    params.username ?? null,
    params.displayName
  )
}

export function addMessage(params: {
  chatId: number
  telegramMessageId: number
  userId: number
  displayName: string
  text: string
}) {
  db.query(
    `INSERT INTO messages
       (chat_id, telegram_message_id, user_id, display_name, text)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    params.chatId,
    params.telegramMessageId,
    params.userId,
    params.displayName,
    params.text
  )

  db.query(
    `UPDATE chats
     SET message_count_since_tags = message_count_since_tags + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE chat_id = ?`
  ).run(params.chatId)
}

export function trimMessages(chatId: number) {
  db.query(
    `DELETE FROM messages
     WHERE chat_id = ?
       AND id NOT IN (
         SELECT id FROM messages
         WHERE chat_id = ?
         ORDER BY id DESC
         LIMIT ?
       )`
  ).run(chatId, chatId, config.MAX_STORED_MESSAGES_PER_CHAT)
}

export function recentMessages(
  chatId: number,
  limit = config.MAX_CONTEXT_MESSAGES
): MessageRecord[] {
  const rows = db
    .query(
      `SELECT telegram_message_id AS telegramMessageId,
              user_id AS userId,
              display_name AS displayName,
              text,
              created_at AS createdAt
       FROM messages
       WHERE chat_id = ?
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(chatId, limit) as MessageRecord[]

  return rows.reverse()
}

export function activeMembers(chatId: number): MemberRecord[] {
  return db
    .query(
      `SELECT user_id AS userId,
              username,
              display_name AS displayName,
              message_count AS messageCount,
              current_tag AS currentTag
       FROM members
       WHERE chat_id = ?
       ORDER BY message_count DESC, last_seen_at DESC`
    )
    .all(chatId) as MemberRecord[]
}

export function rememberTag(chatId: number, userId: number, tag: string) {
  db.query(
    `UPDATE members
     SET current_tag = ?,
         last_tagged_at = CURRENT_TIMESTAMP
     WHERE chat_id = ? AND user_id = ?`
  ).run(tag, chatId, userId)
}

export function markTaggingComplete(chatId: number) {
  db.query(
    `UPDATE chats
     SET message_count_since_tags = 0,
         last_tagged_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE chat_id = ?`
  ).run(chatId)
}

export function markSetupWarningSent(chatId: number) {
  db.query(
    `UPDATE chats
     SET setup_warning_sent_at = CURRENT_TIMESTAMP
     WHERE chat_id = ? AND setup_warning_sent_at IS NULL`
  ).run(chatId)
}

export function closeDb() {
  db.close()
}
