// /api/start-resumable-upload.js

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

export const config = {
  api: {
    bodyParser: true,
  },
};

const oauthClientPath = path.join(process.cwd(), 'oauth-client.json'); // Local file, not from env
const credentials = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));

const tokenPath = path.join(process.cwd(), 'GOOGLE_TOKEN.json'); // ✅ Local file
const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
oauth2Client.setCredentials(token);

const { client_secret, client_id, redirect_uris } = credentials.web;

const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oauth2Client.setCredentials(token);

const drive = google.drive({ version: 'v3', auth: oauth2Client });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fileName, mimeType, userName } = req.body;
  if (!fileName || !mimeType || !userName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const safeName = `${userName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}--${Date.now()}${path.extname(fileName)}`;

    const fileMeta = {
      name: safeName,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
    };

    const uploadRes = await drive.files.create({
      requestBody: fileMeta,
      media: { mimeType },
      fields: 'id',
    }, {
      params: { uploadType: 'resumable' },
    });

    const uploadUrl = uploadRes.headers.location;

    if (!uploadUrl) {
      return res.status(500).json({ error: 'Failed to get upload URL from Google' });
    }

    res.status(200).json({ uploadUrl });
  } catch (err) {
    console.error('❌ Error starting resumable upload:', err);
    res.status(500).json({ error: 'Failed to get upload URL from Google' });
  }
}
