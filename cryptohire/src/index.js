require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const db        = require('./db');
const apiRoutes = require('./api/routes');
const scheduler = require('./scheduler');

const PORT = parseInt(process.env.PORT, 10) || 3001;
const app  = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', apiRoutes);
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function initDbWithRetry(maxAttempts = 8, baseDelayMs = 3000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await db.initSchema();
      console.log('[Boot] DB ready');
      return;
    } catch (err) {
      const detail = err?.message || String(err);
      console.error(`[Boot] DB init attempt ${attempt}/${maxAttempts} failed: ${detail}`);
      if (attempt === maxAttempts) { console.error('[Boot] Giving up.'); process.exit(1); }
      const delay = baseDelayMs * attempt;
      console.log(`[Boot] Retrying in ${delay / 1000}s…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function main() {
  await new Promise((resolve) => {
    app.listen(PORT, () => {
      console.log(`[Server] Listening on port ${PORT}`);
      resolve();
    });
  });

  if (!process.env.DATABASE_URL) {
    console.error('[Boot] DATABASE_URL not set');
    process.exit(1);
  }

  await initDbWithRetry();
  scheduler.start();
}

main().catch((err) => {
  console.error('[Boot] Fatal:', err?.stack || err);
  process.exit(1);
});
