# Nginx Configuration Example

This folder contains example nginx reverse proxy configurations for the CheckBanned API.

## Usage

These are **example configurations only** and should be adapted to your specific deployment setup.

### 3speak-checker.okinoko.io.conf

This configuration:
- Listens on port 80 (HTTP)
- Proxies requests to the local CheckBanned API running on `127.0.0.1:3000`
- Sets proper headers for reverse proxying (X-Real-IP, X-Forwarded-For, X-Forwarded-Proto)
- Enables WebSocket support via the Upgrade header

**To use this configuration:**

1. Copy the file to your nginx sites-available directory:
   ```bash
   sudo cp 3speak-checker.okinoko.io.conf /etc/nginx/sites-available/
   ```

2. Create a symbolic link to enable the site:
   ```bash
   sudo ln -s /etc/nginx/sites-available/3speak-checker.okinoko.io.conf /etc/nginx/sites-enabled/
   ```

3. Update the `server_name` directive to match your domain:
   ```
   server_name your-domain.com;
   ```

4. Test the configuration:
   ```bash
   sudo nginx -t
   ```

5. Reload nginx:
   ```bash
   sudo systemctl reload nginx
   ```

6. (Optional) Set up HTTPS with Let's Encrypt and certbot:
   ```bash
   sudo certbot --nginx -d your-domain.com
   ```

## Configuration Details

- **Port 80**: Standard HTTP (should be upgraded to HTTPS in production)
- **Proxy Pass**: Forwards all requests to `http://127.0.0.1:3000`
- **Headers**: Preserves client information and connection info
- **Connection Upgrade**: Supports WebSocket connections
- **Cache Bypass**: Disables caching of upgraded connections

For production deployments, consider adding:
- HTTPS/SSL configuration
- Rate limiting
- Additional security headers
- Request/response size limits
- Caching policies
