// /api/protected-admin.js
import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const filePath = path.join(process.cwd(), 'public', 'admin.html');
  try {
    const html = fs.readFileSync(filePath, 'utf8');
    res.setHeader("Content-Type", "text/html");
    return res.status(200).send(html);
  } catch (err) {
    return res.status(500).send("Failed to load admin.html");
  }
}
