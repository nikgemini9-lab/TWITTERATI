require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./db');
const apiRoutes  = require('./api/routes');
const scheduler  = require('./scheduler');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const app  = express();

app.use(cors());
app.use(express.json());

// Serve dashboard static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api', apiRoutes);

// SPA fallback – serve index.html for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── DB init with retry ───────────────────────────────────────────────────────

async function initDbWithRetry(maxAttempts = 8, baseDelayMs = 3000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await db.initSchema();
      console.log('[Boot] DB ready');
      return;
    } catch (err) {
      const detail = err?.message || err?.code || JSON.stringify(err) || String(err);
      console.error(`[Boot] DB init attempt ${attempt}/${maxAttempts} failed: ${detail}`);
      if (err?.stack) console.error(err.stack);

      if (attempt === maxAttempts) {
        console.error('[Boot] All DB init attempts exhausted — giving up.');
        process.exit(1);
      }

      const delay = baseDelayMs * attempt; // 3 s, 6 s, 9 s … 24 s
      console.log(`[Boot] Retrying DB in ${delay / 1000}s…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  // Bind the port FIRST so Render's health check / port scanner is satisfied.
  // DB init happens afterward (with retries).
  await new Promise((resolve) => {
    app.listen(PORT, () => {
      console.log(`[Server] Listening on port ${PORT}`);
      resolve();
    });
  });

  if (!process.env.DATABASE_URL) {
    console.error('[Boot] DATABASE_URL is not set — check Render environment variables / database link.');
    process.exit(1);
  }

  await initDbWithRetry();

  scheduler.start();
}

main().catch((err) => {
  console.error('[Boot] Fatal:', err?.stack || err);
  process.exit(1);
});
