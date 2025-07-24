import { createClient } from 'redis';

let redis;
if (!global.redis) {
  redis = createClient({ url: process.env.REDIS_URL });
  redis.connect().catch(console.error);
  global.redis = redis;
} else {
  redis = global.redis;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const [showName, startTime, endTime] = await Promise.all([
        redis.get('showName'),
        redis.get('startTime'),
        redis.get('endTime'),
      ]);

      return res.status(200).json({
        showName: showName || '90 Surge',
        startTime,
        endTime,
      });
    }

    if (req.method === 'POST') {
      const { showName, startTime, endTime } = req.body;

      if (!showName || !startTime || !endTime) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      await redis.set('showName', showName);
      await redis.set('startTime', startTime);
      await redis.set('endTime', endTime);

      return res.status(200).json({ message: '✅ Config saved to Redis' });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    console.error('❌ Error in /api/config:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
