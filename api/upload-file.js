import { google } from 'googleapis';
import { IncomingForm } from 'formidable';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

function sanitizePart(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export const config = {
  api: {
    bodyParser: false,
  },
};

// OAuth2 setup

const oauth2Client = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);

const oauthClientPath = path.join(process.cwd(), 'oauth-client.json');
const oauthClient = JSON.parse(fs.readFileSync(oauthClientPath, 'utf8'));

let tokenData;
if (process.env.GOOGLE_TOKEN_JSON) {
  tokenData = JSON.parse(process.env.GOOGLE_TOKEN_JSON);
} else {
  const tokenPath = path.join(process.cwd(), 'GOOGLE_TOKEN.json');
  tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
}

oauth2Client.setCredentials({
  access_token: tokenData.access_token,
  refresh_token: tokenData.refresh_token,
  scope: tokenData.scope,
  token_type: tokenData.token_type,
  expiry_date: tokenData.expiry_date,
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // ✅ Time restriction logic
  const configPath = path.join(process.cwd(), 'config.json');
  let config = {};

  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error('❌ Failed to load config.json:', err);
    return res.status(500).json({ error: 'Server config error' });
  }

  const now = new Date();
  const start = new Date(config.startTime);
  const end = new Date(config.endTime);

  if (now < start || now > end) {
    return res.status(403).json({ error: 'Uploads are not allowed at this time.' });
  }

  const form = new IncomingForm();

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('❌ Error during file parsing:', err);
      return res.status(500).json({ error: 'File parsing error' });
    }

    if (!files || Object.keys(files).length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const rawName = fields.name || '';
    if (!rawName.trim()) {
      return res.status(400).json({ error: 'Name is required.' });
    }

    const userName = rawName;
    const uploadedFiles = [];

    for (const key in files) {
      const file = files[key];
      if (!file || !file[0] || !file[0].originalFilename || !file[0].filepath) {
        console.error('❌ Missing file properties:', file);
        continue;
      }

      const fileDetails = file[0];
      const showName = process.env.SHOW_NAME || '90surge';
      const timestamp = Date.now();
      const safeName = sanitizePart(rawName);
      const safeShow = sanitizePart(showName);
      const shortTimestamp = String(Date.now()).slice(-4);
      const fileExtension = path.extname(fileDetails.originalFilename);

      const newFileName = `${safeName}-${safeShow}-${shortTimestamp}${fileExtension}`;

      try {
        const fileContent = fs.createReadStream(fileDetails.filepath);

        // Upload file to Google Drive
        const driveResponse = await drive.files.create({
          requestBody: {
            name: newFileName,
            parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
            mimeType: fileDetails.mimetype,
          },
          media: {
            body: fileContent,
          },
        });

        const fileId = driveResponse.data.id;

    // Make file public
await drive.permissions.create({
  fileId,
  requestBody: {
    role: 'reader',
    type: 'anyone',
  },
});

// Get webContentLink
const getLink = await drive.files.get({
  fileId,
  fields: 'webContentLink',
});

        // Store metadata in uploads.json
        const uploadedMeta = {
          name: userName,
          driveFileId: fileId,
          mimeType: fileDetails.mimetype,
          timestamp,
        };

        const uploadsPath = path.join(process.cwd(), 'uploads.json');
        let existingUploads = [];

        try {
          if (fs.existsSync(uploadsPath)) {
            const raw = fs.readFileSync(uploadsPath, 'utf8');
            existingUploads = JSON.parse(raw);
          }
        } catch (readErr) {
          console.error('❌ Failed to read uploads.json:', readErr);
        }

        existingUploads.push(uploadedMeta);

        try {
          fs.writeFileSync(uploadsPath, JSON.stringify(existingUploads, null, 2), 'utf8');
        } catch (writeErr) {
          console.error('❌ Failed to write uploads.json:', writeErr);
        }

        uploadedFiles.push(uploadedMeta);

        // Clean up temp file
        fs.unlinkSync(fileDetails.filepath);
      } catch (uploadError) {
        console.error('❌ Upload failed:', uploadError);
        return res.status(500).json({ error: 'Error uploading file to Google Drive' });
      }
    }

    return res.status(200).json({
      message: 'Files uploaded successfully',
      files: uploadedFiles,
    });
  });
}
