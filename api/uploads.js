// /api/uploads.js
import fs from 'fs';
import path from 'path';
import { createClient } from 'redis';

const uploadsPath = path.join(process.cwd(), 'uploads.json');

export default async function handler(req, res) {
  const isLocal = process.env.VERCEL_ENV !== 'production';
  let entries = [];

  try {
    if (isLocal) {
      if (fs.existsSync(uploadsPath)) {
        const raw = fs.readFileSync(uploadsPath, 'utf8');
        entries = JSON.parse(raw);
      }
    } else {
      const redis = createClient({ url: process.env.REDIS_URL });
      await redis.connect();
      const raw = await redis.lRange('uploads', 0, -1);
      await redis.disconnect();
      entries = raw.map(e => JSON.parse(e));
    }

    const result = entries.map(entry => ({
      ...entry,
      fileUrl: `/api/proxy?id=${entry.driveFileId}`,
      type: entry.mimeType?.startsWith('video/') ? 'video' : 'image',
    }));

    res.status(200).json(result);
  } catch (err) {
    console.error("❌ Failed to load uploads:", err);
    res.status(500).json({ error: 'Could not load uploads' });
  }
}
