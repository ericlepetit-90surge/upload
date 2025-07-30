// /api/save-upload-metadata.js
import { kv } from '@vercel/kv';

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

    await kv.lpush('uploads', JSON.stringify(entry));
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Failed to save upload metadata:", err);
    return res.status(500).json({ error: 'Failed to save metadata' });
  }
}
