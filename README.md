# CheckBanned API aka Pancreas API

A comprehensive REST API for managing and retrieving 3Speak video data, user permissions, and Hive account information from MongoDB.

## Features

- Check user permissions and upload eligibility
- Retrieve Hive usernames from user IDs
- Get video job IDs from owner and permlink
- Fetch user's video library with pagination and filtering
- Search videos by tag with pagination (newest first)
- Get personalized video feeds based on Hive following list
- Get shorts feed with optional app filtering
- Get sorted shorts feed with reward-weighted bucket sorting and deterministic pagination
- Get per-user shorts feed with pagination (all shorts by a specific user)
- **Homepage Feeds**: Recommended, New Content, Trending, and First Uploads
- Automated trending calculation via cron job (every 15 minutes)
- Batch fetch video view counts with caching
- Update video thumbnails (protected endpoint)
- Feature flags for safe deployment (`ENABLE_MONGO_WRITES`)
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
- `API_SECRET_KEY` - Secret key for protected endpoints (thumbnail updates)

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

### Get Shorts Feed
```
GET /shorts?page={page}&limit={limit}&app={frontend_app}
```
Retrieves a feed of published short-form videos from the embed-video collection, sorted by newest first.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number for pagination (minimum: 1) |
| `limit` | number | 20 | Results per page (minimum: 1, maximum: 100) |
| `app` | string | all | Optional filter by frontend_app (e.g., "snapie", "threespeak") |

**Response format:**
```json
{
  "success": true,
  "page": 1,
  "limit": 20,
  "total": 150,
  "totalPages": 8,
  "app": "all",
  "shorts": [
    {
      "owner": "ismeris",
      "permlink": "dyprlkq4",
      "frontend_app": "snapie",
      "views": 5,
      "createdAt": "2026-01-24T18:14:29.649Z",
      "thumbnail_url": "https://ipfs.3speak.tv/ipfs/QmRvP3E4wJAufWCKiuyP2dfkDX8ymzib2KE4bgvwujv4mN",
      "embed_url": "@ismeris/snap-1737745800000",
      "embed_title": "My short video"
    }
  ]
}
```

**Logic:**
- Fetches from `embed-video` collection with filters: `short: true`, `status: "published"`, and `processed: true`
- Optional filtering by `frontend_app` for app-specific feeds
- Results are sorted by `createdAt` field in descending order (newest first)
- View counts are cached for 5 minutes to improve performance
- Returns paginated results with metadata including thumbnail URLs, embed URLs, and titles
- Frontend apps use the `frontend_app` field to display "created with" overlays
- Only returns fully processed shorts ready for viewing

**Example usage:**
```bash
# Get all published shorts
curl http://localhost:3000/shorts

# Get page 2 with 50 results
curl "http://localhost:3000/shorts?page=2&limit=50"

# Get only Snapie shorts
curl "http://localhost:3000/shorts?app=snapie"

# Get only 3Speak shorts
curl "http://localhost:3000/shorts?app=threespeak"
```

### Get Sorted Shorts Feed
```
GET /shortssorted?page={page}&limit={limit}&app={frontend_app}&seed={seed}
```
Retrieves a sorted shorts feed using weighted random scoring with deterministic seeded pagination. Each short receives a composite score combining Hive reward value, recency, and seeded randomness — surfacing higher-rewarded content while still appearing random.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number for pagination (minimum: 1) |
| `limit` | number | 20 | Results per page (minimum: 1, maximum: 100) |
| `app` | string | all | Optional filter by frontend_app (e.g., "snapie", "threespeak") |
| `seed` | number | auto-generated | Seed for deterministic shuffle. Reuse across pages for consistent ordering |

**Response format:**
```json
{
  "success": true,
  "seed": 847293156,
  "page": 1,
  "limit": 20,
  "total": 150,
  "totalPages": 8,
  "app": "all",
  "shorts": [
    {
      "owner": "sergiomendes",
      "permlink": "1fgcz7m4",
      "frontend_app": "snapie",
      "views": 11,
      "hive_reward": 0.33,
      "hive_title": "My short video title",
      "hive_body": "Full post body from Hive...",
      "hive_tags": ["threespeak", "shorts", "hive"],
      "hive_votes": 12,
      "hive_comments": 3,
      "hive_author_reputation": 69.0,
      "hive_followers": 245,
      "createdAt": "2026-02-09T16:18:31.943Z",
      "thumbnail_url": "https://...",
      "embed_url": "@sergiomendes/20260209t162316225z",
      "embed_title": "Comment"
    }
  ]
}
```

**Logic:**
- Fetches from `embed-video` collection (last 14 days) with the same base filters as `/shorts`
- Fetches Hive content data (reward, title, body, tags) for all shorts via RPC (`condenser_api.get_content`) in batches of 20 — cached for 15 minutes
- **Reputation filtering**: Authors with Hive reputation <= 15 are excluded from results
- Each short gets a weighted sort score: `recency_bonus + normalized_reward * REWARD_WEIGHT + seeded_random * (1 - REWARD_WEIGHT)`
  - **Recency bonus**: 4 recent buckets (0–8 days, `SHORT_SORT_INTERVAL` days each) + 1 big bucket (8–14 days) where older content competes on reward + randomness
  - **Reward component**: Normalized against max reward, weighted by `REWARD_WEIGHT` (default: 0.7)
  - **Random component**: Seeded PRNG provides deterministic variety
- **Consecutive author dedup**: If the same author appears multiple times in a row after sorting, only the first occurrence is kept
- **Sorted list caching**: The full sorted order (with title, body, tags) is cached for 15 minutes per seed+app combination — page 2+ requests skip the entire sort pipeline
- Same seed = same sort order = no duplicates across pages
- If no `seed` is provided, one is auto-generated and returned in the response
- Live-changing data (votes, comments, reward, reputation) is fetched fresh for the current page; title, body, and tags come from the cached sorted list
- Follower counts are cached separately for 4 hours; author reputation is cached for 8 hours

**Example usage:**
```bash
# Get sorted shorts (seed auto-generated)
curl http://localhost:3000/shortssorted

# Get page 2 with same seed for consistent ordering
curl "http://localhost:3000/shortssorted?page=2&limit=20&seed=847293156"

# Filter by app
curl "http://localhost:3000/shortssorted?app=snapie&seed=847293156"
```

### Get User Shorts Feed
```
GET /shorts/:username?page={page}&limit={limit}
```
Retrieves all shorts by a specific user, sorted by date descending. Same response shape as `/shortssorted` but without weighted scoring, time window limits, or consecutive-author dedup.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `username` | string | Hive username (1-50 characters) |

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number for pagination (minimum: 1) |
| `limit` | number | 20 | Results per page (minimum: 1, maximum: 100) |

**Response format:**
```json
{
  "success": true,
  "page": 1,
  "limit": 20,
  "total": 42,
  "totalPages": 3,
  "shorts": [
    {
      "owner": "sergiomendes",
      "permlink": "1fgcz7m4",
      "views": 11,
      "hive_reward": 0.33,
      "hive_title": "My short video title",
      "hive_body": "Full post body from Hive...",
      "hive_tags": ["threespeak", "shorts", "hive"],
      "hive_votes": 12,
      "hive_comments": 3,
      "hive_author_reputation": 69.0,
      "hive_followers": 245,
      "createdAt": "2026-02-09T16:18:31.943Z",
      "thumbnail_url": "https://...",
      "embed_url": "@sergiomendes/20260209t162316225z",
      "embed_title": "Comment"
    }
  ]
}
```

**Logic:**
- Fetches from `embed-video` collection with filters: `short: true`, `status: "published"`, `processed: true`, `embed_url` exists, `owner: username`
- No time window — returns all shorts for the user regardless of age
- No weighted scoring or randomization — simply sorted by `createdAt` descending (newest first)
- Uses the same Hive data enrichment as `/shortssorted`: rewards, title, body, tags, live votes/comments, reputation, follower counts
- View counts cached for 5 minutes; Hive rewards cached for 15 minutes; follower counts cached for 4 hours

**Example usage:**
```bash
# Get first 20 shorts by a user
curl http://localhost:3000/shorts/sergiomendes

# Get page 2 with 10 results
curl "http://localhost:3000/shorts/sergiomendes?page=2&limit=10"
```

---

## Homepage Feeds

The API provides four curated feeds for the 3Speak homepage, each serving different content discovery purposes. All feeds exclude the internal `threespeak-fixer` account and only return published videos.

### Get Recommended Feed
```
GET /feeds/recommended?page={page}&limit={limit}
```
Returns curated/recommended videos flagged by administrators.

**Query Parameters:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `page` | number | 1 | - | Page number for pagination |
| `limit` | number | 50 | 100 | Results per page |

**Response format:**
```json
{
  "success": true,
  "feed": "recommended",
  "page": 1,
  "limit": 50,
  "total": 2168,
  "totalPages": 44,
  "videos": [
    {
      "_id": "697fd107eed099d12ab95ab2",
      "owner": "theycallmedan",
      "permlink": "c9d9c5a3",
      "title": "How to use Hive Encrypt",
      "recommended": true,
      "status": "published",
      "views": 107,
      // ... other video fields
    }
  ]
}
```

**Logic:**
- Returns videos with `recommended: true` flag
- Only published videos (`status: "published"`)
- Excludes `threespeak-fixer` internal account
- Sorted by creation date (newest first)

### Get New Content Feed
```
GET /feeds/new?page={page}&limit={limit}
```
Returns recently uploaded videos from established creators (excludes first-time uploaders and trending videos).

**Query Parameters:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `page` | number | 1 | - | Page number for pagination |
| `limit` | number | 50 | 100 | Results per page |

**Response format:**
```json
{
  "success": true,
  "feed": "new",
  "page": 1,
  "limit": 50,
  "total": 129976,
  "totalPages": 2600,
  "videos": [
    {
      "_id": "698000abc123...",
      "owner": "username",
      "permlink": "abc123",
      "title": "My New Video",
      "firstUpload": false,
      "trending": false,
      "status": "published",
      // ... other video fields
    }
  ]
}
```

**Logic:**
- Returns recent content from established creators
- Excludes first-time uploaders (`firstUpload != true`)
- Excludes trending videos (`trending != true`)
- Only published videos (`status: "published"`)
- Excludes `threespeak-fixer` internal account
- Sorted by creation date (newest first)

### Get Trending Feed
```
GET /feeds/trending?page={page}&limit={limit}
```
Returns the top 50 trending videos based on engagement metrics from the last 7 days.

**Query Parameters:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `page` | number | 1 | - | Page number for pagination |
| `limit` | number | 50 | 100 | Results per page |

**Response format:**
```json
{
  "success": true,
  "feed": "trending",
  "page": 1,
  "limit": 50,
  "total": 50,
  "totalPages": 1,
  "videos": [
    {
      "_id": "697fd107eed099d12ab95ab2",
      "owner": "theycallmedan",
      "permlink": "c9d9c5a3",
      "title": "Trending Video",
      "trending": true,
      "views": 107,
      "status": "published",
      // ... other video fields
    }
  ]
}
```

**Logic:**
- Automatically calculated by cron job every 15 minutes
- Top 50 videos from the last 7 days based on engagement score:
  - Views: 1 point each
  - Votes: 2 points each
  - Comments: 3 points each
  - Hive rewards: 10 points each
- Videos flagged with `trending: true`
- Only published videos (`status: "published"`)
- Excludes `threespeak-fixer` internal account
- Sorted by creation date (newest first)

### Get First Uploads Feed
```
GET /feeds/firstUploads?page={page}&limit={limit}
```
Returns videos from first-time creators (excludes trending videos to avoid duplication).

**Query Parameters:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `page` | number | 1 | - | Page number for pagination |
| `limit` | number | 50 | 100 | Results per page |

**Response format:**
```json
{
  "success": true,
  "feed": "firstUploads",
  "page": 1,
  "limit": 50,
  "total": 2772,
  "totalPages": 56,
  "videos": [
    {
      "_id": "697ecc8bc05ccfd7529649c4",
      "owner": "consumerbreak",
      "permlink": "lloyvhlxdm",
      "title": "My First Video",
      "firstUpload": true,
      "trending": false,
      "status": "published",
      // ... other video fields
    }
  ]
}
```

**Logic:**
- Returns videos with `firstUpload: true` flag
- Excludes trending videos (`trending != true`)
- Only published videos (`status: "published"`)
- Excludes `threespeak-fixer` internal account
- Sorted by creation date (newest first)

**Feed Hierarchy:**
Videos are shown in only one feed based on priority:
1. **Trending** (highest priority) - if flagged as trending, appears only here
2. **Recommended** - manually curated content
3. **New Content** - recent uploads from established creators
4. **First Uploads** - content from new creators

**Automated Trending Calculation:**
The trending feed is automatically updated:
- On server startup (immediate calculation)
- Every 15 minutes via cron job
- Ensures fresh trending content without manual intervention

**Example usage:**
```bash
# Get recommended videos
curl http://localhost:3000/feeds/recommended

# Get new content with pagination
curl "http://localhost:3000/feeds/new?page=2&limit=20"

# Get trending videos
curl http://localhost:3000/feeds/trending

# Get first uploads
curl "http://localhost:3000/feeds/firstUploads?page=1&limit=25"
```

---

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

### Update Video Thumbnail (Protected)
```
PUT /video/thumbnail
```
Updates the thumbnail URL for a specific video. This endpoint is protected and requires API key authentication.

**Authentication:**
Requires API key in Authorization header:
```
Authorization: Bearer YOUR_API_SECRET_KEY
```

**Request body:**
```json
{
  "owner": "mantequilla-soft",
  "permlink": "fd9ef87a",
  "thumbnail": "ipfs://QmNewThumbnailCID"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `owner` | string | Yes | Hive username of the video owner |
| `permlink` | string | Yes | Video permlink |
| `thumbnail` | string | Yes | New thumbnail URL (must start with ipfs://, http://, or https://) |

**Response format (success):**
```json
{
  "success": true,
  "message": "Thumbnail updated successfully",
  "data": {
    "owner": "mantequilla-soft",
    "permlink": "fd9ef87a",
    "thumbnail": "ipfs://QmNewThumbnailCID",
    "updated_at": "2026-01-24T20:30:00.000Z"
  }
}
```

**Logic:**
- Validates API key before processing request
- Validates thumbnail URL format (must be IPFS CID or HTTP/HTTPS URL)
- Checks if video exists in the `videos` collection
- Updates thumbnail and adds `thumbnail_updated_at` timestamp
- Logs all updates for audit purposes

**Error responses:**
- `401` - Unauthorized (missing or invalid API key)
- `400` - Invalid request (missing fields or invalid thumbnail format)
- `404` - Video not found
- `500` - Internal server error

**Example usage:**
```bash
# Update video thumbnail
curl -X PUT http://localhost:3000/video/thumbnail \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_SECRET_KEY" \
  -d '{
    "owner": "meno",
    "permlink": "abc123",
    "thumbnail": "ipfs://QmNewThumbnailCID"
  }'

# Update with full URL
curl -X PUT http://localhost:3000/video/thumbnail \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_SECRET_KEY" \
  -d '{
    "owner": "meno",
    "permlink": "abc123",
    "thumbnail": "https://example.com/new-thumbnail.jpg"
  }'
```

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

# Get shorts feed (all apps)
curl http://localhost:3000/shorts

# Get shorts feed with pagination and app filter
curl "http://localhost:3000/shorts?page=1&limit=20&app=snapie"

# Get sorted shorts feed (reward-weighted, seeded pagination)
curl http://localhost:3000/shortssorted

# Get sorted shorts page 2 with same seed
curl "http://localhost:3000/shortssorted?page=2&seed=847293156"

# Get all shorts by a specific user
curl http://localhost:3000/shorts/sergiomendes

# Get user shorts with pagination
curl "http://localhost:3000/shorts/sergiomendes?page=2&limit=10"

# Get recommended feed
curl http://localhost:3000/feeds/recommended

# Get new content feed with pagination
curl "http://localhost:3000/feeds/new?page=2&limit=30"

# Get trending videos
curl http://localhost:3000/feeds/trending

# Get first uploads feed
curl "http://localhost:3000/feeds/firstUploads?page=1&limit=25"

# Update video thumbnail (protected endpoint)
curl -X PUT http://localhost:3000/video/thumbnail \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_SECRET_KEY" \
  -d '{
    "owner": "meno",
    "permlink": "abc123",
    "thumbnail": "ipfs://QmNewThumbnailCID"
  }'

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
  "email": "menosoft@gmail.com",
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

### videos Collection (for /getjobid, /videos/tag, and /video/thumbnail endpoints)
```json
{
  "owner": "tovia01",
  "permlink": "lkgdgnazjd",
  "job_id": "7e1bea23-142d-4b37-a882-676298afd323",
  "title": "testing video upload OPH",
  "tags": "hive,hiveproject,threespeak,devlog,pob",
  "tags_v2": ["hive", "hiveproject", "threespeak", "devlog", "pob"],
  "thumbnail": "ipfs://QmXXXXXX",
  "created": "2026-01-14T04:12:57.275Z",
  // ... other fields
}
```

### embed-video Collection (for /shorts endpoint)
```json
{
  "owner": "ismeris",
  "permlink": "dyprlkq4",
  "frontend_app": "snapie",
  "status": "published",
  "short": true,
  "thumbnail_url": "https://...",
  "duration": null,
  "views": 5,
  "createdAt": "2026-01-24T18:14:29.649Z",
  // ... other fields
}
```

**Recommended Indexes for Performance:**
```javascript
// For optimal performance of /videos/tag endpoint
db.videos.createIndex({ tags_v2: 1, created: -1 })

// For optimal performance of /feed endpoint
db.videos.createIndex({ owner: 1, created: -1 })

// For optimal performance of /shorts endpoint
db['embed-video'].createIndex({ short: 1, status: 1, createdAt: -1 })
db['embed-video'].createIndex({ short: 1, status: 1, frontend_app: 1, createdAt: -1 })
db['embed-video'].createIndex({ short: 1, status: 1, processed: 1, owner: 1, createdAt: -1 })

// For optimal performance of homepage feeds
db.videos.createIndex({ recommended: 1, status: 1, created: -1 })
db.videos.createIndex({ firstUpload: 1, trending: 1, status: 1, created: -1 })
db.videos.createIndex({ trending: 1, status: 1, created: -1 })
db.videos.createIndex({ status: 1, owner: 1, created: -1 })
```

To automatically create all recommended indexes, run:
```bash
cd scripts
node create-indexes.js
```

## Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Server port | 3000 | No |
| `MONGODB_URI` | MongoDB connection string | - | Yes |
| `DATABASE_NAME` | MongoDB database name | - | Yes |
| `COLLECTION_NAME` | MongoDB collection name | - | Yes |
| `API_SECRET_KEY` | Secret key for protected endpoints | - | Yes* |
| `AUTH_JWT_SECRET` | JWT secret for authentication | - | No |
| `ENABLE_MONGO_WRITES` | Enable MongoDB write operations (trending calc, thumbnail updates) | `true` | No |
| `SHORT_SORT_INTERVAL` | Time bucket size in days for `/shortssorted` recency bonus | `2` | No |
| `REWARD_WEIGHT` | Weight for reward vs randomness in sort score (0-1, higher = more reward influence) | `0.7` | No |
| `HIVE_RPC_ENDPOINTS` | Hive RPC endpoints (comma-separated, tries in order on failure) | `https://techcoderx.com,https://api.deathwing.me,https://api.hive.blog` | No |

*Required only if using protected endpoints like `/video/thumbnail`

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