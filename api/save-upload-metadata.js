// /api/save-upload-metadata.js
import fs from 'fs';
import path from 'path';

const uploadsPath = path.join(process.cwd(), 'uploads.json');

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { fileId, userName } = req.body;
  if (!fileId || !userName) return res.status(400).json({ error: 'Missing fields' });

  const uploads = fs.existsSync(uploadsPath)
    ? JSON.parse(fs.readFileSync(uploadsPath))
    : [];

  uploads.push({ fileId, userName, timestamp: Date.now() });

  fs.writeFileSync(uploadsPath, JSON.stringify(uploads, null, 2));
  res.status(200).json({ success: true });
}
