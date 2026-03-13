// Runtime-adjustable config.
// Values start from env vars (or defaults) and can be changed via POST /api/config
// without restarting the server.

const config = {
  minLikes:    parseInt(process.env.MIN_LIKES,    10) || 10000,
  minRetweets: parseInt(process.env.MIN_RETWEETS, 10) || 0,
  maxPages:    parseInt(process.env.MAX_PAGES,    10) || 10,
};

module.exports = config;
