const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'enquiries.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS businesses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slug          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    brand_color   TEXT NOT NULL DEFAULT '#2a78d6',
    access_hash   TEXT,
    inbound_token TEXT NOT NULL UNIQUE,
    settings      TEXT NOT NULL DEFAULT '{}',
    sync_state    TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS enquiries (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id       INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    from_name         TEXT,
    from_email        TEXT NOT NULL,
    phone             TEXT,
    subject           TEXT,
    received_at       TEXT NOT NULL,
    last_inbound_at   TEXT NOT NULL,
    first_response_at TEXT,
    last_response_at  TEXT,
    score             INTEGER NOT NULL DEFAULT 0,
    signals           TEXT NOT NULL DEFAULT '[]',
    budget            REAL,
    temp_override     TEXT CHECK (temp_override IN ('hot','warm','cold')),
    status            TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','contacted','quoted','won','lost','spam')),
    value             REAL,
    notes             TEXT NOT NULL DEFAULT '',
    source            TEXT NOT NULL DEFAULT 'email',
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_enq_business ON enquiries(business_id, received_at);
  CREATE INDEX IF NOT EXISTS idx_enq_sender ON enquiries(business_id, from_email);

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    enquiry_id  INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
    direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
    message_id  TEXT,
    subject     TEXT,
    body        TEXT NOT NULL DEFAULT '',
    sent_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_msg_enquiry ON messages(enquiry_id, sent_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_unique ON messages(enquiry_id, message_id)
    WHERE message_id IS NOT NULL;
`);

// Runs fn in a transaction. Nested calls join the outer transaction.
let depth = 0;
function tx(fn) {
  if (depth > 0) return fn();
  depth += 1;
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth -= 1;
  }
}

module.exports = { db, tx, DATA_DIR };
