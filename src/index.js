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
      return; // success
    } catch (err) {
      const detail = err?.message || err?.code || JSON.stringify(err) || String(err);
      console.error(`[Boot] DB init attempt ${attempt}/${maxAttempts} failed: ${detail}`);

      if (attempt === maxAttempts) {
        console.error('[Boot] All DB init attempts exhausted. Exiting.');
        console.error(err?.stack || err);
        process.exit(1);
      }

      const delay = baseDelayMs * attempt; // 3s, 6s, 9s … 24s
      console.log(`[Boot] Retrying in ${delay / 1000}s…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[Boot] DATABASE_URL is not set. Check your environment variables.');
    process.exit(1);
  }

  // Start HTTP server immediately so Render's health check passes
  app.listen(PORT, () => {
    console.log(`[Server] Listening on port ${PORT}`);
  });

  // Then initialise DB (with retries in case the managed DB isn't ready yet)
  await initDbWithRetry();

  scheduler.start();
}

main();
