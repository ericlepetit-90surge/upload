// /api/save-upload-metadata.js
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

await redis.rpush('uploads', JSON.stringify(newEntry));


export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  try {
    const { userName, driveFileId, mimeType } = req.body;

    if (!userName || !driveFileId) {
      return res.status(400).json({ error: 'Missing userName or driveFileId' });
    }

    const entry = {
      userName,
      driveFileId,
      mimeType,
      count: 1,
      createdAt: Date.now(),
    };

    await redis.lpush('uploads', JSON.stringify(entry));
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Failed to save upload metadata:", err);
    return res.status(500).json({ error: 'Failed to save metadata' });
  }
}
