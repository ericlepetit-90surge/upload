// /api/upload-resumable.js
import { google } from "googleapis";
import { IncomingForm } from "formidable";
import fs from "fs";
import path from "path";

export const config = {
  api: {
    bodyParser: false,
  },
};

const oauthPath = path.join(process.cwd(), "oauth-client.json");
const oauthClient = JSON.parse(fs.readFileSync(oauthPath, "utf8"));
const tokenData = JSON.parse(process.env.GOOGLE_TOKEN_JSON || "{}");

const oauth2Client = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);
oauth2Client.setCredentials(tokenData);

function sanitizeFileName(name) {
  return name
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 100);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const form = new IncomingForm({ multiples: false });
  form.uploadDir = "/tmp";
  form.keepExtensions = true;

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error("❌ Error parsing form:", err);
      return res.status(400).json({ error: "Error parsing form data" });
    }
    console.log("📂 Parsed files:", files);
    const file = files.file;
    const userName = fields.userName?.[0] || fields.userName;

    if (!file || !userName) {
      console.warn("❌ Missing userName or file");
      return res.status(400).json({ error: "Missing userName or file" });
    }

    try {
      const drive = google.drive({ version: "v3", auth: oauth2Client });
      const filePath =
        file.filepath ?? file.path ?? file[0]?.filepath ?? file[0]?.path;
      if (!filePath) {
        console.error("❌ Could not determine file path:", file);
        return res.status(400).json({ error: "Invalid file upload" });
      }
      const mimeType = file.mimetype || file.type || "image/jpeg";
      const originalName = file.originalFilename || file.name || "upload.jpg";

      const cleanFileName = sanitizeFileName(
        `${userName}_${Date.now()}_${originalName}`
      );
      const fileMetadata = {
        name: cleanFileName,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
      };

      const media = {
        mimeType,
        body: fs.createReadStream(filePath),
      };

      const driveRes = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: "id",
      });

      const fileId = driveRes?.data?.id;
      if (!fileId) throw new Error("No file ID returned");

      // Save metadata (optional, based on your system)

      console.log("📤 Sending metadata:", {
  fileId,
  fileName: cleanFileName,
  userName,
  mimeType,
});

      await fetch(`${req.headers.origin}/api/save-upload-metadata`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId,
          fileName: cleanFileName,
          userName,
          mimeType,
        }),
      });

      return res.status(200).json({ success: true, fileId });
    } catch (error) {
      console.error("🔥 Upload error:", error.message || error);
      return res.status(500).json({ error: "Upload failed" });
    }
  });
}
