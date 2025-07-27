// /api/start-resumable-upload.js

import { google } from 'googleapis';
import path from 'path';
import fs from 'fs';

export const config = {
  api: {
    bodyParser: true,
  },
};

const oauthClientPath = path.join(process.cwd(), 'oauth-client.json');
const oauthClient = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));
const token = JSON.parse(process.env.GOOGLE_TOKEN_JSON || '{}');

const oauth2Client = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);
oauth2Client.setCredentials(token);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  const { fileName, mimeType, userName } = req.body;

  if (!fileName || !mimeType || !userName) {
    return res.status(400).json({ error: 'Missing fileName, mimeType, or userName' });
  }

  try {
    const { token } = await oauth2Client.getAccessToken();

    const safeFileName = `${userName}--${Date.now()}--${fileName}`.replace(/[^a-zA-Z0-9_.-]/g, '_');

    const sessionRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': mimeType,
      },
      body: JSON.stringify({
        name: safeFileName,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
        mimeType,
      }),
    });

    const uploadUrl = sessionRes.headers.get('location');
    if (!uploadUrl) {
      const err = await sessionRes.text();
      throw new Error(`Google did not return upload URL: ${err}`);
    }

    return res.status(200).json({ uploadUrl });
  } catch (err) {
    console.error('🔥 Failed to start resumable upload:', err);
    return res.status(500).json({ error: 'Could not start resumable upload' });
  }
}
