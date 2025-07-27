// /api/save-upload-metadata.js
const fs = require('fs');
const path = require('path');

const uploadsPath = path.join(process.cwd(), 'uploads.json');

module.exports = function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { fileId, userName } = req.body;
  if (!fileId || !userName) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  let uploads = [];
  if (fs.existsSync(uploadsPath)) {
    try {
      uploads = JSON.parse(fs.readFileSync(uploadsPath, 'utf8'));
    } catch (err) {
      console.error('❌ Failed to read uploads.json:', err);
    }
  }

  uploads.push({ fileId, userName, timestamp: Date.now() });

  try {
    fs.writeFileSync(uploadsPath, JSON.stringify(uploads, null, 2));
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Failed to write uploads.json:', err);
    res.status(500).json({ error: 'Failed to save metadata' });
  }
};
