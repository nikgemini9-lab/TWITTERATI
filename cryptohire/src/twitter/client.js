'use strict';

const { Rettiwt } = require('rettiwt-api');

let _client = null;

function getClient() {
  if (!_client) {
    const cookie = process.env.TWITTER_COOKIE;
    if (!cookie) throw new Error('TWITTER_COOKIE env var not set');
    _client = new Rettiwt({ apiKey: cookie });
  }
  return _client;
}

module.exports = { getClient };
