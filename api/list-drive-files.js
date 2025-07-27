import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// Load OAuth credentials
const oauthClientPath = path.join(process.cwd(), 'oauth-client.json');
const oauthClient = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));

const oauth2Client = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);

const tokenJson = process.env.GOOGLE_TOKEN_JSON;
if (!tokenJson) throw new Error('Missing GOOGLE_TOKEN_JSON in environment.');

const token = JSON.parse(tokenJson);
oauth2Client.setCredentials(token);

const drive = google.drive({ version: 'v3', auth: oauth2Client });

export default async function handler(req, res) {
  try {
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) {
      return res.status(500).json({ error: 'Missing Google Drive folder ID' });
    }

    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, createdTime)',
      orderBy: 'createdTime desc',
    });

    const files = (response.data.files || []).map((file) => {
      const isImage = file.mimeType?.startsWith('image/');
      const type = isImage ? 'image' : 'other';
      const userName = file.name.split('--')[0] || 'Anonymous';

      return {
        name: file.name,
        userName,
        fileUrl: `/api/proxy?id=${file.id}`,
        type,
        driveFileId: file.id,
        timestamp: new Date(file.createdTime).getTime(),
      };
    });

    res.status(200).json(files);
  } catch (err) {
    console.error('❌ Failed to list Drive files:', err);
    res.status(500).json({ error: 'Failed to list Google Drive files' });
  }
}
