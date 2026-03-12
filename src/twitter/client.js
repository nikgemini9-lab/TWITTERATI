const { TwitterApi } = require('twitter-api-v2');

let _client = null;

function getClient() {
  if (_client) return _client;

  const token = process.env.TWITTER_BEARER_TOKEN;
  if (!token) {
    throw new Error('TWITTER_BEARER_TOKEN environment variable is not set');
  }

  _client = new TwitterApi(token).readOnly;
  return _client;
}

module.exports = { getClient };
