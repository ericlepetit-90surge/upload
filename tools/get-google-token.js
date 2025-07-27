// tools/get-google-token.js
import { google } from 'googleapis';
import readline from 'readline';
import fs from 'fs';
import path from 'path';

const oauthPath = path.join(process.cwd(), 'oauth-client.json');
const credentials = JSON.parse(fs.readFileSync(oauthPath));
const { client_id, client_secret, redirect_uris } = credentials.web;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

// Step 1: Get code from user
const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',      // ✅ required for refresh_token
  prompt: 'consent',           // ✅ force new token even if previously granted
  scope: ['https://www.googleapis.com/auth/drive.file'],
});

console.log('👉 Authorize this app by visiting this URL:\n', authUrl);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('\nPaste the code from that page here: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    console.log('\n✅ Success! Here’s your new token:\n');
    console.log(JSON.stringify(tokens, null, 2));
    console.log('\n👉 Paste this in your .env as GOOGLE_TOKEN_JSON');
  } catch (err) {
    console.error('❌ Error retrieving access token', err.message);
  }
});
