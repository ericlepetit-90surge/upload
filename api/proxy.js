import { google } from 'googleapis';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Google Auth
const oauthClientPath = path.join(process.cwd(), 'oauth-client.json');
const oauthClient = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));

const oauth2Client = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);

const tokenPath = path.join(process.cwd(), 'GOOGLE_TOKEN.json'); // ✅ Local file
const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
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

    res.setHeader('Content-Type', driveRes.headers['content-type'] || 'application/octet-stream');

    driveRes.data.pipe(res);
  } catch (err) {
    console.error('❌ Proxy failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch file from Drive' });
  }
}
