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

  export default function AdminPage() {
  return (
    <div style={{ padding: 30 }}>
      <h1>Admin Panel</h1>
      <p>You’re logged in.</p>
      {/* Load your original admin HTML content here */}
    </div>
  );
}

export async function getServerSideProps({ req, res }) {
  const auth = req.headers.authorization;
  const correctPass = process.env.ADMIN_PASS || 'secret';

  // Dev bypass
  if (req.headers.host.startsWith('localhost')) {
    return { props: {} };
  }

  if (!auth) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    res.end('Auth required');
    return { props: {} }; // Will never be reached
  }

  const base64 = auth.split(' ')[1];
  const [user, pass] = Buffer.from(base64, 'base64').toString().split(':');

  if (pass !== correctPass) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    res.end('Invalid password');
    return { props: {} };
  }

  return { props: {} };
}

}
