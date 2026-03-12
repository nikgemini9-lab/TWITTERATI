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

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await db.initSchema();
  } catch (err) {
    console.error('[Boot] DB schema init failed:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[Server] Listening on port ${PORT}`);
  });

  scheduler.start();
}

main();
