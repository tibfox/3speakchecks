# CheckBanned API

A simple REST API that checks user permissions and retrieves Hive usernames from a MongoDB database.

## Features

- Check user permissions for posting
- Retrieve Hive usernames from user IDs
- Connects to MongoDB to verify user status
- Environment-based configuration
- CORS enabled for cross-origin requests
- Health check endpoint

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables:
```bash
# Copy the example environment file
cp .env.example .env

# Edit .env with your actual MongoDB credentials and configuration
```

Required environment variables:
- `PORT` - Server port (default: 3000)
- `MONGODB_URI` - Your MongoDB connection string
- `DATABASE_NAME` - Your MongoDB database name
- `COLLECTION_NAME` - Your MongoDB collection name

3. Start the server:
```bash
# Development mode with auto-restart
npm run dev

# Production mode
npm start
```

## API Endpoints

### Health Check
```
GET /
```
Returns API status and available endpoints.

### Check User Permissions
```
GET /check/:username
```
Checks if a user can make posts based on their `banned` and `canUpload` status.

**Response format:**
```json
{
  "canPost": true,
  "username": "meno",
  "banned": false,
  "canUpload": true
}
```

**Logic:**
- User can post if: `banned = false` AND `canUpload = true`
- Returns `canPost: false` if user not found or doesn't meet criteria

### Get Hive Username
```
GET /gethive/:user_id
```
Retrieves the Hive username associated with a user ID by querying the users and hiveaccounts collections.

**Response format:**
```json
"meno"
```

**Logic:**
- Searches `users` collection for the provided `user_id`
- Uses the `last_identity` field to find the corresponding Hive account in `hiveaccounts` collection
- Returns the `account` field (Hive username)
- Returns `"No user ID found"` if user ID not found or no associated Hive account

## Example Usage

```bash
# Health check
curl http://localhost:3000

# Check if user "meno" can make posts
curl http://localhost:3000/check/meno

# Get Hive username for user ID
curl http://localhost:3000/gethive/48d37d99-34ec-4098-be92-682dbbb93379
```

## Database Schema

The API uses multiple MongoDB collections:

### contentcreators Collection (for /check endpoint)
```json
{
  "username": "meno",
  "banned": false,
  "canUpload": true,
  // ... other fields
}
```

### users Collection (for /gethive endpoint)
```json
{
  "user_id": "48d37d99-34ec-4098-be92-682dbbb93379",
  "email": "menoecua@gmail.com",
  "last_identity": ObjectId("612bf9256b1c8555334eec15"),
  // ... other fields
}
```

### hiveaccounts Collection (for /gethive endpoint)
```json
{
  "_id": ObjectId("612bf9256b1c8555334eec15"),
  "account": "meno",
  "user_id": ObjectId("612bf8e0c8382759076be696"),
  // ... other fields
}
```

## Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Server port | 3000 | No |
| `MONGODB_URI` | MongoDB connection string | - | Yes |
| `DATABASE_NAME` | MongoDB database name | - | Yes |
| `COLLECTION_NAME` | MongoDB collection name | - | Yes |

## Production Deployment

### Setting up as a System Service

1. **On your production server**, clone and setup:
```bash
git clone https://github.com/menobass/3speakbanchecker.git
cd 3speakbanchecker
npm install --production
```

2. **Configure environment**:
```bash
cp .env.example .env
# Edit .env with your production values
```

3. **Install as systemd service**:
```bash
sudo ./setup-service.sh
```

This will:
- Install the service to start automatically on boot
- Configure proper logging via syslog
- Set security restrictions
- Start the service immediately

### Service Management Commands
```bash
sudo systemctl start checkbanned-api     # Start service
sudo systemctl stop checkbanned-api      # Stop service
sudo systemctl restart checkbanned-api   # Restart service
sudo systemctl status checkbanned-api    # Check status
sudo journalctl -u checkbanned-api -f    # View live logs
```

## Security Notes

- Never commit your `.env` file to version control
- Use strong authentication credentials for MongoDB
- Consider using environment variables or secrets management in production
- Ensure your MongoDB instance is properly secured
- The systemd service runs with restricted permissions for security