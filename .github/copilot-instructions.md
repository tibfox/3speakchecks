<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->

# CheckBanned API Project Instructions

This project is a Node.js REST API that checks user permissions in a MongoDB database.

## Project Structure
- Express.js server for REST API endpoints
- MongoDB connection for user permission checking
- Environment-based configuration
- Simple yes/no responses for user post permissions

## Key Features
- `/check/:username` endpoint to verify if a user can make posts
- Checks `banned` and `canUpload` fields in the contentcreators collection
- Configurable MongoDB connection via environment variables
- Simple JSON responses

## Development Notes
- Connects to MongoDB database via environment variables
- Checks user permissions in contentcreators collection
- Response format: {"canPost": true/false}
- Environment-based configuration for security