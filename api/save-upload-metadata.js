// /api/save-upload-metadata.js
import fs from 'fs';
import path from 'path';
import { kv } from '@vercel/kv';

const uploadsPath = path.join(process.cwd(), 'uploads.json');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { userName, driveFileId, mimeType } = req.body;

  if (!userName || !driveFileId) {
    return res.status(400).json({ error: 'Missing userName or driveFileId' });
  }

  const entry = {
    userName,
    driveFileId,
    mimeType,
    timestamp: new Date().toISOString(),
    count: 1
  };

  try {
    const isLocal = process.env.VERCEL_ENV !== 'production';

    if (isLocal) {
      let existing = [];

      if (fs.existsSync(uploadsPath)) {
        const raw = fs.readFileSync(uploadsPath, 'utf8');
        existing = JSON.parse(raw);
      }

      if (!Array.isArray(existing)) existing = [];

      existing.push(entry);
      fs.writeFileSync(uploadsPath, JSON.stringify(existing, null, 2));
    } else {
      await kv.rpush('uploads', JSON.stringify(entry));
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Failed to save metadata:', err);
    return res.status(500).json({ error: 'Failed to save metadata' });
  }
}
