const fs = require("fs");
const path = require("path");

export default function handler(req, res) {
  const uploadsPath = path.join(process.cwd(), "uploads.json");

  try {
    if (!fs.existsSync(uploadsPath)) {
      return res.status(200).json([]);
    }

    const data = fs.readFileSync(uploadsPath, "utf8");
    let rawUploads;

    try {
      rawUploads = JSON.parse(data);
    } catch (jsonErr) {
      console.error("❌ JSON parse error in uploads.json:", jsonErr);
      return res.status(500).json({ error: "uploads.json is not valid JSON" });
    }

    if (!Array.isArray(rawUploads)) {
      console.error("❌ uploads.json is not an array:", rawUploads);
      return res.status(500).json({ error: "uploads.json must be an array" });
    }

    const publicDomain = process.env.R2_PUBLIC_DOMAIN;

    const uploads = rawUploads.map((entry) => {
      const { fileName, mimeType, userName, createdTime } = entry;
      const fileUrl = `https://${publicDomain}/${fileName}`;
      const type = mimeType?.startsWith("video/") ? "video" : "image";

      return {
        userName: userName || "Anonymous",
        fileUrl,
        type,
        timestamp: createdTime || null,
        votes: entry.votes || 0, // ✅ Add votes to keep entry count logic working
      };
    });

    res.status(200).json(uploads);
  } catch (err) {
    console.error("❌ Failed to read uploads.json:", err);
    res.status(500).json({ error: "Failed to read uploads list." });
  }
}
