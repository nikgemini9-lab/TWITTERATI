// Runtime-adjustable config.
// Values start from env vars (or defaults) and can be changed via POST /api/config
// without restarting the server.

const config = {
  minLikes:    parseInt(process.env.MIN_LIKES,    10) || 12000,
  minRetweets: parseInt(process.env.MIN_RETWEETS, 10) || 0,
  language:    process.env.LANGUAGE || null,   // e.g. 'en' to restrict Twitter search to English
};

module.exports = config;
