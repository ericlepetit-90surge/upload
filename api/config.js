import { createClient } from 'redis';

export const config = {
  api: {
    bodyParser: true,
  },
};

// Keep redis client cached
let redis;

async function getRedis() {
  if (!redis) {
    redis = createClient({
      url: process.env.REDIS_URL,
    });

    redis.on('error', (err) => console.error('Redis Client Error:', err));
    await redis.connect();
  }

  return redis;
}

export default async function handler(req, res) {
  try {
    const client = await getRedis();

    if (req.method === 'GET') {
      const [showName, startTime, endTime] = await Promise.all([
        client.get('config:showName'),
        client.get('config:startTime'),
        client.get('config:endTime'),
      ]);

      return res.status(200).json({
        showName: showName || '90 Surge',
        startTime,
        endTime,
      });
    }

    if (req.method === 'POST') {
      const { showName, startTime, endTime } = req.body;

      if (!showName || typeof showName !== 'string') {
        return res.status(400).json({ error: 'Invalid showName' });
      }

      await client.set('config:showName', showName);
      if (startTime) await client.set('config:startTime', startTime);
      if (endTime) await client.set('config:endTime', endTime);

      return res.status(200).json({ message: '✅ Config saved to Redis' });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error) {
    console.error('❌ Redis error in /api/config:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
