const mongoose = require('mongoose');

// Connection string must come from the environment — never hardcode credentials.
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  throw new Error('MONGO_URI is not set. Add it to your .env file (see .env.example).');
}

// Optimized connection options for serverless environments
const connectionOptions = {
  serverSelectionTimeoutMS: 30000, // Increase timeout to 30 seconds
  socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
  maxPoolSize: 10, // Maintain up to 10 socket connections
  family: 4 // Use IPv4, skip trying IPv6
};

// Set mongoose options separately for serverless environments
// Set bufferCommands to true to queue operations until connection is established
mongoose.set('bufferCommands', true);

// Initial connection promise to track the first connection attempt
let connectionPromise = null;

// Initialize connection
const initializeConnection = async () => {
  if (!connectionPromise) {
    connectionPromise = mongoose.connect(MONGO_URI, connectionOptions)
      .then((connection) => {
        console.log(`✅ Connected to MongoDB Database: ${mongoose.connection.name}`);
        return connection;
      })
      .catch((err) => {
        console.error('❌ MongoDB Connection Error:', err);
        // Reset promise on error so we can retry
        connectionPromise = null;
        // Don't exit in serverless environment, just log the error
        if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
          process.exit(1);
        }
        throw err;
      });
  }
  return connectionPromise;
};

// Start initial connection
initializeConnection().catch(console.error);

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB Connection Error (Runtime):', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('🔌 MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  console.log('🔄 MongoDB reconnected');
});

// Export a function to ensure connection for serverless environments
const ensureConnection = async () => {
  // readyState values: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  if (mongoose.connection.readyState === 1) {
    // Already connected
    return;
  }

  // If initial connection hasn't completed, wait for it
  if (connectionPromise) {
    try {
      await connectionPromise;
      // Check if we're actually connected after waiting
      if (mongoose.connection.readyState === 1) {
        return;
      }
      // Connection promise resolved but we're not connected, need to reconnect
      connectionPromise = null;
    } catch (error) {
      // Initial connection failed, reset and try again
      connectionPromise = null;
    }
  }

  if (mongoose.connection.readyState === 2) {
    // Currently connecting, wait for it to complete
    await new Promise((resolve, reject) => {
      mongoose.connection.once('connected', resolve);
      mongoose.connection.once('error', reject);
      // Add timeout to prevent infinite waiting
      setTimeout(() => reject(new Error('Connection timeout')), 30000);
    });
    return;
  }

  // Not connected and not connecting, establish new connection
  console.log('🔄 Establishing MongoDB connection...');
  try {
    // Reset the connection promise since we're establishing a new connection
    connectionPromise = null;
    await initializeConnection();

    // Wait for the connection to be fully established
    if (mongoose.connection.readyState !== 1) {
      await new Promise((resolve, reject) => {
        mongoose.connection.once('connected', resolve);
        mongoose.connection.once('error', reject);
        setTimeout(() => reject(new Error('Connection timeout')), 30000);
      });
    }

    console.log('✅ MongoDB connection established');
  } catch (error) {
    console.error('❌ Failed to connect to MongoDB:', error);
    throw error;
  }
};

module.exports = { mongoose, ensureConnection };
