'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const TOPICS = [
  'Football/Soccer', 'Basketball/NBA', 'Cricket', 'Sports-Other',
  'Music/Pop', 'K-Pop', 'Anime/Manga', 'Gaming', 'VTubers/Streaming',
  'Crypto/Web3', 'Finance/Stocks', 'Tech/AI', 'Politics',
  'Celebrity/Drama', 'Film/TV', 'Memes', 'News', 'Other',
];

const TOPIC_LIST = TOPICS.join(', ');
const TOPIC_SET  = new Set(TOPICS);

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.warn('[AI] ANTHROPIC_API_KEY not set — topic classification disabled');
}

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: API_KEY });
  return client;
}

/**
 * Classify up to 50 tweets into topic categories using Claude Haiku.
 * @param {Array<{ tweet_id: string, tweet_text: string }>} tweets
 * @returns {Promise<Array<{ tweet_id: string, topic: string }>>}
 */
async function batchClassifyTweets(tweets) {
  if (!API_KEY || !tweets.length) return [];

  const tweetList = tweets
    .map((t, i) => `${i + 1}. [ID:${t.tweet_id}] ${(t.tweet_text || '').slice(0, 280)}`)
    .join('\n');

  const prompt = `You are a tweet topic classifier. Classify each tweet into exactly one topic from this list:
${TOPIC_LIST}

Rules:
- Pick the MOST SPECIFIC matching topic. Use "Other" only when nothing fits.
- For sports: prefer Football/Soccer, Basketball/NBA, Cricket over Sports-Other.
- For music: prefer K-Pop over Music/Pop if the tweet is clearly K-Pop related.
- Reply ONLY with a valid JSON array. No markdown, no explanation, no code fences.

Format: [{"id":"<tweet_id>","topic":"<topic>"},...]

Tweets to classify:
${tweetList}`;

  let raw;
  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    raw = response.content[0]?.text?.trim() || '[]';
  } catch (err) {
    console.error('[AI] Claude API error:', err.message);
    return [];
  }

  let parsed;
  try {
    const clean = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    console.error('[AI] Failed to parse classification response:', raw.slice(0, 200));
    return [];
  }

  return parsed
    .filter(entry => entry && entry.id && TOPIC_SET.has(entry.topic))
    .map(entry => ({ tweet_id: String(entry.id), topic: entry.topic }));
}

module.exports = { batchClassifyTweets, TOPICS };
