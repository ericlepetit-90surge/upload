// /api/admin.js
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

export default function handler(req, res) {
  // Allow GET only
  if (req.method !== 'GET') {
    return res.status(405).send('Method Not Allowed');
  }

  const { password } = req.query;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).send('Unauthorized: Invalid password');
  }

  const htmlPath = path.join(process.cwd(), 'public', 'admin.html');

  try {
    let html = fs.readFileSync(htmlPath, 'utf8');

    // Inject script to load show name
    html = html.replace(
      '</body>',
      `<script>
        fetch('/api/config?password=${encodeURIComponent(process.env.ADMIN_PASSWORD)}')
          .then(r => r.json())
          .then(d => {
            const el = document.getElementById('show-name');
            if (el) el.textContent = d.showName || 'Not set';
          })
          .catch(err => {
            console.error('Error fetching config:', err);
            const el = document.getElementById('show-name');
            if (el) el.textContent = 'Error loading';
          });
      </script></body>`
    );

    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(html);
  } catch (err) {
    console.error('❌ Failed to read admin.html:', err);
    res.status(500).send('Admin panel could not be loaded.');
  }
}
