// src/helper/helper.js
const jwt = require('jsonwebtoken');

/**
 * Extracts user information from JWT token
 * @param {string} token - JWT token from Authorization header
 * @returns {Object|null} User object or null if invalid token
 */
function getUserFromToken(token) {
  if (!token) return null;
  
  try {
    // Remove 'Bearer ' prefix if present
    const tokenValue = token.startsWith('Bearer ') ? token.slice(7) : token;
    const secret = process.env.JWT_SECRET;
    
    if (!secret) {
      console.error('JWT_SECRET is not configured');
      return null;
    }
    
    // Verify and decode the token
    const decoded = jwt.verify(tokenValue, secret);
    
    // Return only the user information we need
    return {
      id: decoded.id,
      email: decoded.email,
      firstName: decoded.firstName,
      lastName: decoded.lastName
    };
  } catch (error) {
    console.error('Error decoding token:', error.message);
    return null;
  }
}

module.exports = {
  getUserFromToken
};