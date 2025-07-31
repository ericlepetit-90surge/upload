// /api/winner.js
import { createClient } from 'redis';

const isLocal = process.env.VERCEL_ENV !== 'production';

export default async function handler(req, res) {
  try {
    if (isLocal) {
      // Optional: return a dummy winner for local testing
      return res.json({ winner: null });
    }

    const redis = createClient({ url: process.env.REDIS_URL });
    await redis.connect();

    const winnerData = await redis.get('raffle_winner');
    await redis.disconnect();

    if (!winnerData) {
      return res.json({ winner: null });
    }

    const parsed = JSON.parse(winnerData);
    return res.json({ winner: parsed });
  } catch (err) {
    console.error('🔥 /api/winner error:', err);
    res.status(500).json({ error: 'Failed to fetch winner' });
  }
}