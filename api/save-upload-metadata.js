// /api/save-upload-metadata.js
import fs from 'fs';
import path from 'path';
import { createClient } from 'redis';

export const config = {
  api: { bodyParser: true },
};

const uploadsPath = path.join(process.cwd(), 'uploads.json');

export default async function handler(req, res) {
  const isLocal = process.env.VERCEL_ENV !== 'production';
  const { userName, driveFileId, fileName, mimeType } = req.body;

  if (!userName || !driveFileId) {
    return res.status(400).json({ error: 'Missing userName or driveFileId' });
  }

  const newEntry = {
    userName: userName.trim(),
    driveFileId,
    fileName,
    mimeType,
    timestamp: Date.now(),
  };

  try {
    if (isLocal) {
      const data = fs.existsSync(uploadsPath)
        ? JSON.parse(fs.readFileSync(uploadsPath, 'utf8'))
        : [];
      data.push(newEntry);
      fs.writeFileSync(uploadsPath, JSON.stringify(data, null, 2));
    } else {
      const redis = createClient({ url: process.env.REDIS_URL });
      await redis.connect();
      await redis.rPush('uploads', JSON.stringify(newEntry));
      await redis.disconnect();
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Failed to save metadata:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
