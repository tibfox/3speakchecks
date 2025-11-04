
# CheckBanned API Project Instructions

This project is a Node.js REST API that checks user permissions in a MongoDB database.

## Project Structure
- Express.js server for REST API endpoints
- MongoDB connection for user permission checking
- Environment-based configuration
- Simple yes/no responses for user post permissions

## Key Features
- `/check/:username` endpoint to verify if a user can make posts
- `/gethive/:user_id` endpoint to get Hive username from user ID
- `/getjobid/:owner/:permlink` endpoint to get video job ID
- Checks `banned` and `canUpload` fields in the contentcreators collection
- Queries users and hiveaccounts collections for Hive username lookup
- Queries videos collection for job ID retrieval
- Configurable MongoDB connection via environment variables
- Simple JSON responses

## Development Notes
- Connects to MongoDB database via environment variables
- Checks user permissions in contentcreators collection
- Response format: {"canPost": true/false}
- Environment-based configuration for security