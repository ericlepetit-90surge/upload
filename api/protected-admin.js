// /api/protected-admin.js
import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const filePath = path.join(process.cwd(), 'public', 'admin.html');
  const html = fs.readFileSync(filePath, 'utf8');
  return res.status(200).send(html);
}