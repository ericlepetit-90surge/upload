// /api/start-resumable-upload.js
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");
const formidable = require("formidable");
const mime = require("mime-types");

const oauthPath = path.join(process.cwd(), "oauth-client.json");
const oauthClient = JSON.parse(fs.readFileSync(oauthPath, "utf8"));
const tokenData = JSON.parse(process.env.GOOGLE_TOKEN_JSON || "{}");

const oauth2Client = new google.auth.OAuth2(
  oauthClient.web.client_id,
  oauthClient.web.client_secret,
  oauthClient.web.redirect_uris[0]
);
oauth2Client.setCredentials(tokenData);

module.exports.config = {
  api: { bodyParser: false },
};

function sanitizeFileName(name) {
  return name
    .replace(/[^\w.\- ]+/g, "") // remove special chars
    .replace(/\s+/g, "_")       // replace whitespace with _
    .substring(0, 100);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const form = new formidable.IncomingForm({ keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    console.log("📥 Incoming form parse");
    console.log("FIELDS:", fields);
    console.log("FILES:", files);

    if (err) {
      console.error("❌ Form parse error:", err);
      return res.status(400).json({ error: "Failed to parse form data" });
    }

    const userNameRaw = Array.isArray(fields.userName)
      ? fields.userName[0]?.toString().trim()
      : fields.userName?.toString().trim();

    const file = Array.isArray(files.file) ? files.file[0] : files.file;

    if (!userNameRaw || !file) {
      console.error("❌ Missing userName or file");
      return res.status(400).json({ error: "Missing userName or file" });
    }

    const userName = sanitizeFileName(userNameRaw);
    const originalFileName = sanitizeFileName(file.originalFilename || file.name || "upload");
    const filePath = file.filepath || file.path;
    const fileName = `${userName}_${Date.now()}_${originalFileName}`;
    const mimeType = file.mimetype || mime.lookup(filePath) || "application/octet-stream";

    const drive = google.drive({ version: "v3", auth: oauth2Client });

    try {
      const { token } = await oauth2Client.getAccessToken();
      if (!token) throw new Error("No access token");

      console.log("🧾 Prepared Upload Info:");
      console.log("👤 userNameRaw:", userNameRaw);
      console.log("📄 fileName:", fileName);
      console.log("📁 mimeType:", mimeType);
      console.log("📂 Folder ID:", process.env.GOOGLE_DRIVE_FOLDER_ID);
      console.log("🔐 Using access token:", token.slice(0, 20) + "...");

      const session = await drive.files.create(
        {
          requestBody: {
            name: fileName,
            mimeType,
            parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
          },
          media: {
            mimeType,
          },
          fields: "id",
        },
        {
          params: { uploadType: "resumable" },
        }
      );

      const uploadUrl = session.res?.headers?.location;

      if (!uploadUrl) {
        console.error("❌ No upload URL returned");
        return res.status(500).json({ error: "Failed to get upload URL" });
      }

      console.log("✅ Upload URL:", uploadUrl);

      return res.status(200).json({
        uploadUrl,
        fileName,
        mimeType,
        userName: userNameRaw,
      });
    } catch (err) {
      console.error("🔥 Upload error:", err.response?.data || err.message || err);
      return res.status(500).json({ error: "Upload failed" });
    }
  });
};
