// /api/protected-admin.js
import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const auth = req.headers.authorization;
  const ADMIN_PASS = process.env.ADMIN_PASS || 'secret';
  const isLocal = req.headers.host.includes('localhost');

  if (!isLocal) {
    if (!auth) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Admin Area"',
      });
      return res.end('Authentication required');
    }

    const [scheme, encoded] = auth.split(' ');
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');

    if (pass !== ADMIN_PASS) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Admin Area"',
      });
      return res.end('Invalid credentials');
    }
  }

  const filePath = path.join(process.cwd(), 'public', 'admin.html');
  try {
    const html = fs.readFileSync(filePath, 'utf8');
    res.setHeader('Content-Type', 'text/html'); // ✅ this line is critical
    res.status(200).end(html);
  } catch (err) {
    console.error('❌ Failed to read admin.html:', err);
    res.status(500).end('Internal Server Error');
  }
}
