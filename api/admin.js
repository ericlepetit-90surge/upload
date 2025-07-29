// /api/admin.js
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { randomUUID } from 'crypto';

const ADMIN_PASS = process.env.ADMIN_PASS;
const MODERATOR_PASS = process.env.MODERATOR_PASS;
const uploadsPath = path.join(process.cwd(), 'uploads.json');
const configPath = path.join(process.cwd(), 'config.json');
const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

const oauthClient = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'oauth-client.json'), 'utf8'));
const tokenData = JSON.parse(process.env.GOOGLE_TOKEN_JSON || '{}');

const auth = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);
auth.setCredentials(tokenData);

export default async function handler(req, res) {
  const action = req.query.action;

  // ----------------- LOGIN -----------------
  if (action === 'login' && req.method === 'POST') {
    const { password } = req.body;
    if (password === ADMIN_PASS) return res.json({ success: true, role: 'admin' });
    if (password === MODERATOR_PASS) return res.json({ success: true, role: 'moderator' });
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }

// ----------------- CONFIG -----------------
if (action === 'config' && req.method === 'GET') {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return res.status(200).json(config);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load config' });
  }
}

if (action === 'config' && req.method === 'POST') {
  try {
    fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2));
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save config' });
  }
}

  // ----------------- PICK WINNER -----------------
  if (action === 'pick-winner') {
    try {
      const data = JSON.parse(fs.readFileSync(uploadsPath, 'utf8'));
      if (!data || data.length === 0) return res.status(404).json({ error: 'No entries found' });

      const allEntries = [];
      data.forEach(entry => {
        for (let i = 0; i < entry.count; i++) allEntries.push(entry.userName);
      });

      const winner = allEntries[Math.floor(Math.random() * allEntries.length)];
      return res.json({ winner });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to pick winner' });
    }
  }

  // ----------------- DELETE FILE -----------------
  if (action === 'delete-file' && req.method === 'POST') {
    const { fileId } = req.body;
    if (!fileId) return res.status(400).json({ error: 'Missing file ID' });

    try {
      const drive = google.drive({ version: 'v3', auth });
      await drive.files.delete({ fileId });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to delete file' });
    }
  }

  // ----------------- LIST FILES -----------------

if (action === 'list-drive-files' && req.method === 'GET') {
  try {
    const drive = google.drive({ version: 'v3', auth });
    const resp = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id, name, mimeType, webContentLink)'
    });

    const files = resp.data.files.map(file => ({
  userName: file.name.split('_')[0],
  type: file.mimeType.startsWith('image') ? 'image' : 'video',
  fileUrl: `/api/proxy?id=${file.id}`,
  driveFileId: file.id
}));

    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.json(files);
  } catch (err) {
    console.error("🔥 list-drive-files error:", err);
    return res.status(500).json({ error: 'Failed to list files' });
  }
}

  res.status(400).json({ error: 'Invalid action' });
}
