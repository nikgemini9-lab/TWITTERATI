const { Rettiwt } = require('rettiwt-api');

let _client = null;

function getClient() {
  if (_client) return _client;

  const apiKey = process.env.RETTIWT_API_KEY;

  // apiKey is optional – Rettiwt works in guest mode without one,
  // but guest mode has stricter limits and may not return viewCount.
  // For reliable viewCount and higher limits, provide an API key.
  const config = {
    delay: parseInt(process.env.REQUEST_DELAY_MS, 10) || 1000,
    logging: process.env.RETTIWT_LOGGING === 'true',
  };

  if (apiKey) {
    config.apiKey = apiKey;
  } else {
    console.warn('[Twitter] RETTIWT_API_KEY not set – running in guest mode');
  }

  _client = new Rettiwt(config);
  return _client;
}

module.exports = { getClient };
