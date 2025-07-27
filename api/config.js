// /api/config.js
const { createClient } = require('redis');

let redis;
if (!global.redis) {
  redis = createClient({ url: process.env.REDIS_URL });
  redis.connect().catch(console.error);
  global.redis = redis;
} else {
  redis = global.redis;
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const showName = await redis.get('showName');
      const startTime = await redis.get('startTime');
      const endTime = await redis.get('endTime');
      return res.status(200).json({ showName, startTime, endTime });
    } catch (err) {
      console.error('Failed to fetch config:', err);
      return res.status(500).json({ error: 'Could not fetch config' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { showName, startTime, endTime } = req.body;
      if (showName) await redis.set('showName', showName);
      if (startTime) await redis.set('startTime', startTime);
      if (endTime) await redis.set('endTime', endTime);
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('Failed to save config:', err);
      return res.status(500).json({ error: 'Could not save config' });
    }
  }

  res.status(405).end('Method Not Allowed');
};
