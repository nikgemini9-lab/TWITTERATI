// Runtime config — adjustable via POST /api/config without restart

const config = {
  // Minimum likes for a tweet to be pulled from search.
  // Low on purpose: hiring posts from real people in the space get 20-200 likes,
  // not 10K. The AI classifier does the heavy filtering.
  minLikes: parseInt(process.env.MIN_LIKES, 10) || 20,

  // Minimum AI confidence (0–1) to store a classified job.
  // Tweets below this threshold are discarded.
  minConfidence: 0.80,
};

module.exports = config;
