const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'chatxhasan.db');

// Initialize database
const db = new sqlite3.Database(dbPath);

// Create tables
db.serialize(() => {
  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      profile_photo TEXT,
      status TEXT DEFAULT 'offline',
      last_seen INTEGER,
      created_at INTEGER DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Chats table
  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      group_name TEXT,
      user1_id TEXT,
      user2_id TEXT,
      created_by TEXT,
      created_at INTEGER
    )
  `);
  
  // Chat members table
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id TEXT,
      user_id TEXT,
      joined_at INTEGER,
      PRIMARY KEY (chat_id, user_id)
    )
  `);
  
  // Messages table
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      content TEXT,
      type TEXT DEFAULT 'text',
      reply_to TEXT,
      file_url TEXT,
      file_name TEXT,
      created_at INTEGER,
      FOREIGN KEY (chat_id) REFERENCES chats(id),
      FOREIGN KEY (sender_id) REFERENCES users(id)
    )
  `);
  
  // Message reactions table
  db.run(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT,
      user_id TEXT,
      reaction TEXT,
      created_at INTEGER,
      PRIMARY KEY (message_id, user_id)
    )
  `);
  
  // Blocked users table
  db.run(`
    CREATE TABLE IF NOT EXISTS blocked_users (
      user_id TEXT,
      blocked_user_id TEXT,
      created_at INTEGER,
      PRIMARY KEY (user_id, blocked_user_id)
    )
  `);
  
  // Notifications table
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      message_id TEXT,
      chat_id TEXT,
      created_at INTEGER
    )
  `);
  
  // Group photos table
  db.run(`
    CREATE TABLE IF NOT EXISTS group_photos (
      group_id TEXT PRIMARY KEY,
      photo_url TEXT
    )
  `);
  
  // Create indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_chat_members_user_id ON chat_members(user_id)');
});

module.exports = {
  get: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  },
  all: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },
  run: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }
};
