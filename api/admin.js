// /api/admin.js
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { kv } from '@vercel/kv';

const ADMIN_PASS = process.env.ADMIN_PASS;
const MODERATOR_PASS = process.env.MODERATOR_PASS;
const uploadsPath = path.join(process.cwd(), 'uploads.json');
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
  const isLocal = process.env.VERCEL_ENV !== 'production';

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
      if (isLocal) {
        const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8'));
        return res.status(200).json(config);
      } else {
        const showName = await kv.get('showName');
        const startTime = await kv.get('startTime');
        const endTime = await kv.get('endTime');
        return res.status(200).json({ showName, startTime, endTime });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Failed to load config' });
    }
  }

  if (action === 'config' && req.method === 'POST') {
    try {
      const { showName, startTime, endTime } = req.body;
      if (isLocal) {
        fs.writeFileSync(
          path.join(process.cwd(), 'config.json'),
          JSON.stringify({ showName, startTime, endTime }, null, 2)
        );
      } else {
        await kv.set('showName', showName || '');
        await kv.set('startTime', startTime || '');
        await kv.set('endTime', endTime || '');
      }
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to save config' });
    }
  }

  // ----------------- PICK WINNER -----------------
  if (action === 'pick-winner') {
    try {
      let allUploads = [];

      if (isLocal) {
        const fileData = fs.readFileSync(uploadsPath, 'utf8');
        allUploads = JSON.parse(fileData);
      } else {
        const raw = await kv.lrange('uploads', 0, -1);
        allUploads = raw.map(entry => JSON.parse(entry));
      }

      if (!Array.isArray(allUploads) || allUploads.length === 0) {
        return res.status(404).json({ error: 'No entries found' });
      }

      // Get currently existing files on Drive
      const drive = google.drive({ version: 'v3', auth });
      const resp = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id)'
      });
      const liveFileIds = new Set(resp.data.files.map(f => f.id));

      const eligibleUploads = allUploads.filter(entry => {
        const id = entry.driveFileId || entry.fileId;
        return id && liveFileIds.has(id);
      });

      const allEntries = [];
      eligibleUploads.forEach(entry => {
        const name = entry.userName || entry.name;
        const count = parseInt(entry.count || 1);
        if (name) {
          for (let i = 0; i < count; i++) allEntries.push(name);
        }
      });

      if (allEntries.length === 0) {
        return res.status(400).json({ error: 'No valid entries with active files' });
      }

      const winner = allEntries[Math.floor(Math.random() * allEntries.length)];
      return res.json({ winner });

    } catch (err) {
      console.error('🔥 pick-winner failed:', err);
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

      const files = resp.data.files.map(file => {
        const userName = file.name?.split('_')[0] || 'Unknown';
        return {
          name: userName,
          type: file.mimeType.startsWith('image') ? 'image' : 'video',
          fileUrl: `/api/proxy?id=${file.id}`,
          driveFileId: file.id
        };
      });

      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.json(files);
    } catch (err) {
      console.error("🔥 list-drive-files error:", err);
      return res.status(500).json({ error: 'Failed to list files' });
    }
  }

  res.status(400).json({ error: 'Invalid action' });
}
