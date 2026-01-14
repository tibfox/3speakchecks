# Database Scripts

This folder contains maintenance and optimization scripts for the CheckBanned API database.

## Scripts

### create-indexes.js

Creates performance-optimizing indexes on the MongoDB database.

**What it does:**
- Creates a compound index on `{ owner: 1, created: -1 }` for the feed endpoint
- Creates a compound index on `{ tags_v2: 1, created: -1 }` for the tag search endpoint
- Lists all existing indexes after creation

**Why these indexes are important:**
- **Without indexes**: MongoDB scans thousands of documents one by one (slow, takes seconds)
- **With indexes**: MongoDB uses lookup tables for instant results (fast, takes milliseconds)
- Especially critical when filtering by owner (100-500 usernames) or tags

**How to run:**
```bash
cd scripts
node create-indexes.js
```

**Expected output:**
```
Connecting to MongoDB...
Creating indexes for performance optimization...

Creating index: { owner: 1, created: -1 }
✓ Index created: owner_created_desc

Creating index: { tags_v2: 1, created: -1 }
✓ Index created: tags_v2_created_desc

All indexes on videos collection:
  - _id_: {"_id":1}
  - owner_created_desc: {"owner":1,"created":-1}
  - tags_v2_created_desc: {"tags_v2":1,"created":-1}

✓ All indexes created successfully!

MongoDB connection closed.
```

**Is it safe?**
- ✅ Yes! Indexes don't modify any data
- ✅ Existing queries work exactly the same
- ✅ Just makes searches faster
- ✅ Can be added/removed anytime
- ✅ Created with `background: true` to avoid blocking operations

**When to run:**
- After initial database setup
- Before deploying the feed or tag endpoints
- Any time you notice slow query performance

**Requirements:**
- MongoDB connection configured in `.env`
- Same environment variables as the main server
