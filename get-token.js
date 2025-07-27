import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const TOKEN_PATH = path.join(process.cwd(), 'GOOGLE_TOKEN.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'oauth-client.json');

async function main() {
  const content = fs.readFileSync(CREDENTIALS_PATH);
  const credentials = JSON.parse(content);
  const { client_secret, client_id, redirect_uris } = credentials.web;

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // ← force refresh token every time
});

  console.log('Authorize this app by visiting this URL:', authUrl);

  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code).then(({ tokens }) => {
      if (!tokens.refresh_token) {
        console.error('❌ No refresh_token received. Try again with ?prompt=consent in the URL.');
        process.exit(1);
      }
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      console.log('✅ Token saved to', TOKEN_PATH);
    }).catch(err => {
      console.error('❌ Error retrieving access token', err);
    });
  });
}

main();
