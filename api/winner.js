import fs from 'fs';
import path from 'path';

const uploadsPath = path.join(process.cwd(), 'uploads.json');

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!fs.existsSync(uploadsPath)) {
      return res.status(200).json({ message: 'No uploads yet' });
    }

    const data = fs.readFileSync(uploadsPath, 'utf8');
    const uploads = JSON.parse(data);

    if (!uploads.length) {
      return res.status(200).json({ message: 'No uploads yet' });
    }

    const winner = uploads[Math.floor(Math.random() * uploads.length)];
    res.status(200).json({ winner });
  } catch (err) {
    console.error('❌ Error selecting winner:', err);
    res.status(500).json({ error: 'Failed to pick a winner' });
  }
}
