import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const uploadsPath = path.join(process.cwd(), 'uploads.json');

  try {
    if (!fs.existsSync(uploadsPath)) {
      return res.status(200).json([]);
    }

    const data = fs.readFileSync(uploadsPath, 'utf8');
    let rawUploads;

    try {
      rawUploads = JSON.parse(data);
    } catch (jsonErr) {
      console.error('❌ JSON parse error in uploads.json:', jsonErr);
      return res.status(500).json({ error: 'uploads.json is not valid JSON' });
    }

    if (!Array.isArray(rawUploads)) {
      console.error('❌ uploads.json is not an array:', rawUploads);
      return res.status(500).json({ error: 'uploads.json must be an array' });
    }

    const uploads = rawUploads.map(entry => {
  const { name, driveFileId, mimeType, timestamp } = entry;
  const fileUrl = `/api/proxy?id=${driveFileId}`;
  const type = mimeType?.startsWith('video/') ? 'video' : 'image';

  return {
    name: name || 'Anonymous',
    fileUrl,
    type,
    timestamp
  };
});

    res.status(200).json(uploads);
  } catch (err) {
    console.error('❌ Failed to read uploads.json:', err);
    res.status(500).json({ error: 'Failed to read uploads list.' });
  }
}
