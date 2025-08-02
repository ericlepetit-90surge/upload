import { google } from "googleapis";
import { IncomingForm } from "formidable";
import path from "path";
import fs from "fs";
import axios from "axios";

export const config = {
  api: {
    bodyParser: false,
  },
};

const oauthClientPath = path.join(process.cwd(), "oauth-client.json");
const credentials = JSON.parse(fs.readFileSync(oauthClientPath, "utf8"));
const { client_id, client_secret, redirect_uris } = credentials.web;

const tokenData = JSON.parse(process.env.GOOGLE_TOKEN_JSON || "{}");

const oauth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

oauth2Client.setCredentials({
  access_token: tokenData.access_token,
  refresh_token: tokenData.refresh_token,
  expiry_date: tokenData.expiry_date,
});

function sanitize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const form = new IncomingForm();

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error("❌ Form parsing error:", err);
      return res.status(400).json({ error: "Form parsing error" });
    }

    const userName = (fields.userName || "").toString().trim();
    const file = files.file;

    if (!file || !userName) {
      console.error("❌ Missing file or name", { file, userName });
      return res.status(400).json({ error: "Missing file or name" });
    }

    const fileName = `${sanitize(userName)}_${Date.now()}_${sanitize(file.originalFilename || file.name)}`;
    const mimeType = file.mimetype || "application/octet-stream";
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

    try {
      const { token: accessToken } = await oauth2Client.getAccessToken();

      const metadata = {
        name: fileName,
        parents: [folderId],
      };

      const response = await axios.post(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
        metadata,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": mimeType,
          },
        }
      );

      const uploadUrl = response.headers.location;
      console.log("✅ Upload URL:", uploadUrl);

      if (!uploadUrl) {
        throw new Error("No upload URL returned from Drive");
      }

      return res.status(200).json({ uploadUrl, fileName });
    } catch (err) {
      console.error("🔥 Google Drive upload session failed:", err?.response?.data || err);
      return res.status(500).json({ error: "Failed to create upload session" });
    }
  });
}
