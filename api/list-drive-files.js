import { google } from 'googleapis';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Auth setup
const oauthClientPath = path.join(process.cwd(), 'oauth-client.json');
const oauthClient = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));

const oauth2Client = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);

const tokenData = JSON.parse(process.env.GOOGLE_TOKEN_JSON);
oauth2Client.setCredentials(tokenData);

const drive = google.drive({ version: 'v3', auth: oauth2Client });

export default async function handler(req, res) {
  try {
    const response = await drive.files.list({
      q: `'${process.env.GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, createdTime)',
      orderBy: 'createdTime desc'
    });

    const files = response.data.files.map(file => {
      const type = file.mimeType.startsWith('video/') ? 'video' : 'image';

      return {
        name: file.name,
        fileUrl: `/api/proxy?id=${file.id}`, // loads through your own proxy
        type,
        timestamp: new Date(file.createdTime).getTime()
      };
    });

    res.status(200).json(files);
  } catch (err) {
    console.error('❌ Failed to list Drive files:', err);
    res.status(500).json({ error: 'Failed to list Google Drive files' });
  }
}
