# CheckBanned API

A simple REST API that checks if users are allowed to make posts based on their permissions stored in a MongoDB database.

## Features

- Simple GET endpoint to check user permissions
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

## Example Usage

```bash
# Check if user "meno" can make posts
curl http://localhost:3000/check/meno

# Health check
curl http://localhost:3000
```

## Database Schema

The API expects documents in the `contentcreators` collection with this structure:
```json
{
  "username": "meno",
  "banned": false,
  "canUpload": true,
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

## Security Notes

- Never commit your `.env` file to version control
- Use strong authentication credentials for MongoDB
- Consider using environment variables or secrets management in production
- Ensure your MongoDB instance is properly secured