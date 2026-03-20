const { Rettiwt } = require('rettiwt-api');

let _client    = null;
let _cachedKey = null;   // track which key the client was built with

function getClient() {
  // Rebuild the client if the env var changed (e.g. after a hot env update)
  const apiKey = (process.env.RETTIWT_API_KEY || '').trim();

  if (_client && _cachedKey === apiKey) return _client;

  const cfg = {
    delay:   parseInt(process.env.REQUEST_DELAY_MS, 10) || 2000,
    logging: process.env.RETTIWT_LOGGING === 'true',
  };

  if (apiKey) {
    cfg.apiKey = apiKey;
    console.log('[Twitter] Building Rettiwt client with API key');
  } else {
    console.warn('[Twitter] RETTIWT_API_KEY not set – running in guest mode');
  }

  _client    = new Rettiwt(cfg);
  _cachedKey = apiKey;
  return _client;
}

module.exports = { getClient };
