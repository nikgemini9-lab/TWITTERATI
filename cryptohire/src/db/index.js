const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

function sslConfig() {
  const url = process.env.DATABASE_URL || '';
  if (url.includes('localhost') || url.includes('127.0.0.1')) return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  ssl:                     sslConfig(),
  max:                     10,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 8000,
});

pool.on('error', (err) => {
  console.error('[DB] Pool error:', err?.message || err);
});

async function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query(schema);
    console.log('[DB] Schema initialised');
  } finally {
    client.release();
  }
}

module.exports = { pool, query: (...args) => pool.query(...args), initSchema };
