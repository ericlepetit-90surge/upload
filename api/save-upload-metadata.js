// /api/save-upload-metadata.js
import fs from 'fs';
import path from 'path';
import { createClient } from 'redis';

export const config = {
  api: {
    bodyParser: true,
  },
};

const uploadsPath = path.join(process.cwd(), 'uploads.json');

export default async function handler(req, res) {
  const isLocal = process.env.VERCEL_ENV !== 'production';

  try {
    const { userName, driveFileId, mimeType } = req.body;

    if (!userName || !driveFileId) {
      console.warn("Missing userName or driveFileId", req.body);
      return res.status(400).json({ error: 'Missing userName or driveFileId' });
    }

    const newEntry = {
      name: userName.toString().trim(), // preserve full name
      driveFileId,
      mimeType: mimeType || 'unknown',
      timestamp: Date.now()
    };

    if (isLocal) {
      const data = fs.existsSync(uploadsPath)
        ? JSON.parse(fs.readFileSync(uploadsPath, 'utf8'))
        : [];
      data.push(newEntry);
      fs.writeFileSync(uploadsPath, JSON.stringify(data, null, 2));
    } else {
      const redis = createClient({ url: process.env.REDIS_URL });
      await redis.connect();
      await redis.rpush("uploads", JSON.stringify({
  fileId,
  fileName,
  userName, // ✅ include this!
  createdTime: new Date().toISOString(),
}));
      await redis.disconnect();
    }

    console.log("✅ Metadata saved:", newEntry);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Failed to save upload metadata:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
