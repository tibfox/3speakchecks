# CheckBanned API

A comprehensive REST API for managing and retrieving 3Speak video data, user permissions, and Hive account information from MongoDB.

## Features

- Check user permissions and upload eligibility
- Retrieve Hive usernames from user IDs
- Get video job IDs from owner and permlink
- Fetch user's video library with pagination and filtering
- Search videos by tag with pagination (newest first)
- Batch fetch video view counts with caching
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

### Get Job ID
```
GET /getjobid/:owner/:permlink
```
Retrieves the job ID for a video by querying the videos collection with owner and permlink.

**Response format:**
```json
{
  "jobId": "7e1bea23-142d-4b37-a882-676298afd323",
  "owner": "tovia01",
  "permlink": "lkgdgnazjd"
}
```

**Logic:**
- Searches `videos` collection for matching `owner` and `permlink`
- Returns the `job_id` field with context
- Returns `{"error": "Video not found"}` if video not found or job_id missing

### Get Videos by Tag
```
GET /videos/tag/:tag?page={page}&limit={limit}
```
Retrieves all videos containing a specific tag, sorted by creation date (newest first).

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number for pagination (minimum: 1) |
| `limit` | number | 20 | Results per page (minimum: 1, maximum: 100) |

**Response format:**
```json
{
  "tag": "hive",
  "page": 1,
  "limit": 20,
  "total": 156,
  "totalPages": 8,
  "videos": [
    {
      "_id": "696717c8c4cd0d57d080e0ed",
      "owner": "meno",
      "permlink": "1b463a9e",
      "title": "Video Title",
      "tags_v2": ["hive", "threespeak", "devlog"],
      "created": "2026-01-14T04:12:57.275Z",
      // ... other video fields
    }
  ]
}
```

**Logic:**
- Searches `videos` collection for the tag in the `tags_v2` array field
- Tag matching is case-insensitive
- Results are sorted by `created` field in descending order (newest first)
- Returns paginated results with metadata

**Example usage:**
```bash
# Get first 20 videos with tag "hive"
curl http://localhost:3000/videos/tag/hive

# Get page 2 with 50 results
curl http://localhost:3000/videos/tag/hive?page=2&limit=50

# Get first 10 videos with tag "devlog"
curl http://localhost:3000/videos/tag/devlog?page=1&limit=10
```

### Get Personalized Video Feed
```
GET /feed/:username?page={page}&limit={limit}
```
Retrieves a personalized video feed showing recent videos from accounts that the specified user follows on Hive.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number for pagination (minimum: 1) |
| `limit` | number | 20 | Results per page (minimum: 1, maximum: 100) |

**Response format:**
```json
{
  "username": "meno",
  "feedType": "personalized",
  "following": 378,
  "page": 1,
  "limit": 20,
  "total": 11546,
  "totalPages": 578,
  "videos": [
    {
      "_id": "6965bacac4cd0d57d080b420",
      "owner": "shiftrox",
      "permlink": "f9580320",
      "title": "Video Title",
      "created": "2026-01-14T12:05:00.000Z",
      // ... other video fields
    }
  ]
}
```

**Logic:**
- Fetches the user's following list from Hive blockchain API (up to 1000 accounts)
- Following list is cached for 10 minutes to improve performance
- Filters videos to only show content from followed accounts
- Results are sorted by `created` field in descending order (newest first)
- Returns paginated results with metadata
- **Fallback behavior**: If the following list cannot be fetched or is empty, returns all videos instead (feedType will be "all")
- Console logs are generated when fallback occurs or API errors happen

**Example usage:**
```bash
# Get first 20 videos from accounts meno follows
curl http://localhost:3000/feed/meno

# Get page 2 with 50 results
curl "http://localhost:3000/feed/meno?page=2&limit=50"

# Get first 10 videos from another user's feed
curl "http://localhost:3000/feed/theycallmedan?limit=10"
```

### Get Video View Counts
```
POST /views
```
Fetches view counts for one or more videos in a single batch request.

**Request body:**
```json
{
  "videos": [
    { "author": "username1", "permlink": "video-permlink-1" },
    { "author": "username2", "permlink": "video-permlink-2" }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `videos` | array | Yes | Array of video identifiers (1-50 items) |
| `videos[].author` | string | Yes | Hive username of the video author |
| `videos[].permlink` | string | Yes | Video permlink |

**Response format:**
```json
{
  "success": true,
  "data": {
    "username1/video-permlink-1": 1542,
    "username2/video-permlink-2": 8923
  }
}
```

**Logic:**
- Fetches view counts from 3speak.tv API for each video
- Returns `null` for videos not found
- Results are cached for 5 minutes to reduce API load
- Maximum 50 videos per request

**Error responses:**
- `400` - Invalid request body or missing videos array
- `400` - Too many videos (max 50)
- `500` - Internal server error

## Example Usage

```bash
# Health check
curl http://localhost:3000

# Check if user "meno" can make posts
curl http://localhost:3000/check/meno

# Get Hive username for user ID
curl http://localhost:3000/gethive/48d37d99-34ec-4098-be92-682dbbb93379

# Get job ID for a video
curl http://localhost:3000/getjobid/tovia01/lkgdgnazjd

# Get videos by tag (first page, 20 results)
curl http://localhost:3000/videos/tag/hive

# Get videos by tag with pagination
curl "http://localhost:3000/videos/tag/hive?page=2&limit=50"

# Get personalized feed for a user
curl http://localhost:3000/feed/meno

# Get personalized feed with pagination
curl "http://localhost:3000/feed/meno?page=2&limit=50"

# Get view counts for multiple videos
curl -X POST http://localhost:3000/views \
  -H "Content-Type: application/json" \
  -d '{
    "videos": [
      {"author": "theycallmedan", "permlink": "video-1"},
      {"author": "starkerz", "permlink": "video-2"}
    ]
  }'
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

### videos Collection (for /getjobid and /videos/tag endpoints)
```json
{
  "owner": "tovia01",
  "permlink": "lkgdgnazjd",
  "job_id": "7e1bea23-142d-4b37-a882-676298afd323",
  "title": "testing video upload OPH",
  "tags": "hive,hiveproject,threespeak,devlog,pob",
  "tags_v2": ["hive", "hiveproject", "threespeak", "devlog", "pob"],
  "created": "2026-01-14T04:12:57.275Z",
  // ... other fields
}
```

**Recommended Index for Performance:**
```javascript
// For optimal performance of /videos/tag endpoint
db.videos.createIndex({ tags_v2: 1, created: -1 })
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