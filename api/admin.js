import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

export default async function handler(req, res) {
  // Only allow GET requests
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  // Password check
  const { password } = req.query;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).send('Unauthorized: Invalid password');
  }

  const htmlPath = path.join(process.cwd(), 'admin.html');

  try {
    // Read the admin.html file content
    let html = fs.readFileSync(htmlPath, 'utf8');

    // Inject a script that fetches and displays the current show name from the backend
    html = html.replace(
      '</body>',
      `<script>
        // Fetch the current show name from the backend API
        fetch('/api/config?password=${encodeURIComponent(process.env.ADMIN_PASSWORD)}')
          .then(response => response.json())
          .then(data => {
            // Update the show name on the page
            document.getElementById('show-name').textContent = data.showName;
          })
          .catch(error => {
            console.error('Error fetching config:', error);
            document.getElementById('show-name').textContent = 'Error loading show name';
          });
      </script></body>`
    );

    // Send the modified HTML to the client
    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(html);
  } catch (err) {
    console.error('❌ Failed to read admin.html:', err);
    res.status(500).send('Admin panel could not be loaded.');
  }
}
