// Runtime-adjustable config.
// Values start from env vars (or defaults) and can be changed via POST /api/config
// without restarting the server.

const config = {
  minLikes:  parseInt(process.env.MIN_LIKES,  10) || 3000,
  hoursBack: parseInt(process.env.HOURS_BACK, 10) || 2,
  maxPages:  parseInt(process.env.MAX_PAGES,  10) || 10,
};

module.exports = config;
