'use strict';

const { createClient } = require('@libsql/client');
const fs   = require('fs');
const path = require('path');

const TURSO_URL        = process.env.TURSO_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL) {
  console.warn('[DB] TURSO_URL not set');
}

let _client = null;
function getClient() {
  if (!_client) {
    _client = createClient({
      url:       TURSO_URL,
      authToken: TURSO_AUTH_TOKEN,
    });
  }
  return _client;
}

// Thin wrapper — returns { rows } like pg did so queries.js stays clean
async function query(sql, args = []) {
  const rs = await getClient().execute({ sql, args });
  return { rows: rs.rows };
}

async function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // Run each statement individually (libsql doesn't support multi-statement exec)
  const statements = schema.split(';').map((s) => s.trim()).filter(Boolean);
  for (const sql of statements) {
    try {
      await getClient().execute(sql);
    } catch (err) {
      // ALTER TABLE … ADD COLUMN fails if the column already exists (no IF NOT EXISTS in SQLite).
      // Silently skip — the column is already there.
      if (err.message && err.message.includes('duplicate column name')) continue;
      throw err;
    }
  }
  console.log('[DB] Schema initialised');
}

module.exports = { query, initSchema };
