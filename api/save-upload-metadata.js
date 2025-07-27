// /api/save-upload-metadata.js
import fs from 'fs';
import path from 'path';

const uploadsPath = path.join(process.cwd(), 'uploads.json');

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { fileId, userName } = req.body;

  if (!fileId || !userName) {
    return res.status(400).json({ error: 'Missing fileId or userName' });
  }

  try {
    const uploads = fs.existsSync(uploadsPath)
      ? JSON.parse(fs.readFileSync(uploadsPath, 'utf8'))
      : [];

    uploads.push({
      fileId,
      userName,
      timestamp: Date.now(),
    });

    fs.writeFileSync(uploadsPath, JSON.stringify(uploads, null, 2));
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Failed to save upload metadata:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
