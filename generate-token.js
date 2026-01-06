const jwt = require('jsonwebtoken');
require('dotenv').config();

// Generate a test token for your username
const token = jwt.sign(
    { 
        username: 'meno',  // Change this to the username you want to test with
        // Add other fields if your frontend includes them
    }, 
    process.env.AUTH_JWT_SECRET
);

console.log('Test JWT Token:');
console.log(token);
console.log('\nTest with curl:');
console.log(`curl -H "Authorization: Bearer ${token}" "http://localhost:3000/api/my-videos?limit=5"`);
