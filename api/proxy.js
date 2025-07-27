// /api/proxy.js
import { google } from 'googleapis';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// OAuth2 setup
const oauthClientPath = path.join(process.cwd(), 'oauth-client.json');
const credentials = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));

const { client_id, client_secret, redirect_uris } = credentials.web;
const oauth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

// Token fallback (prefer env var)
const token = process.env.GOOGLE_TOKEN_JSON
  ? JSON.parse(process.env.GOOGLE_TOKEN_JSON)
  : JSON.parse(fs.readFileSync(path.join(process.cwd(), 'GOOGLE_TOKEN.json'), 'utf8'));

oauth2Client.setCredentials(token);

const drive = google.drive({ version: 'v3', auth: oauth2Client });

export default async function handler(req, res) {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Missing file ID' });
  }

  try {
    const driveRes = await drive.files.get(
      { fileId: id, alt: 'media' },
      { responseType: 'stream' }
    );

    const contentType = driveRes.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    driveRes.data
      .on('error', (streamErr) => {
        console.error('❌ Stream error:', streamErr);
        res.status(500).end('Error streaming file');
      })
      .pipe(res);
  } catch (err) {
    if (err.code === 404) {
      console.warn('⚠️ File not found:', id);
      return res.status(404).json({ error: 'File not found' });
    }

    console.error('❌ Proxy failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch file from Drive' });
  }
}
