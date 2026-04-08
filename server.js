const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Uploads folder
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// JWT
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-12345-change-it';

// Database
const db = new sqlite3.Database('./chat.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    profile_photo TEXT DEFAULT 'https://via.placeholder.com/150?text=Avatar'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    photo TEXT DEFAULT 'https://via.placeholder.com/150?text=Group',
    created_by INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER,
    user_id INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER,
    receiver_id INTEGER,
    group_id INTEGER,
    message_text TEXT,
    message_type TEXT DEFAULT 'text',
    file_url TEXT,
    reply_to INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Auth middleware
const authenticateToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Socket auth
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return next(new Error('Authentication error'));
    socket.user = user;
    next();
  });
});

// ==================== ROUTES ====================

// Register
app.post('/register', async (req, res) => {
  const { email, password, first_name, last_name } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  db.run(`INSERT INTO users (email, password, first_name, last_name) VALUES (?,?,?,?)`,
    [email, hashed, first_name, last_name], function (err) {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ success: true, user_id: this.lastID });
    });
});

// Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    if (err || !user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, first_name: user.first_name, last_name: user.last_name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: user.id, first_name: user.first_name, last_name: user.last_name, profile_photo: user.profile_photo } });
  });
});

// Upload profile photo
app.post('/upload-profile', authenticateToken, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `/uploads/${req.file.filename}`;
  db.run(`UPDATE users SET profile_photo = ? WHERE id = ?`, [url, req.user.id]);
  res.json({ success: true, profile_photo: url });
});

// Get all users (for Active Users & Personal Chat list)
app.get('/users', authenticateToken, (req, res) => {
  db.all(`SELECT id, first_name, last_name, profile_photo FROM users WHERE id != ?`, [req.user.id], (err, users) => {
    res.json(users);
  });
});

// Create Group
app.post('/create-group', authenticateToken, (req, res) => {
  const { name, members } = req.body; // members = array of user ids
  db.run(`INSERT INTO groups (name, created_by) VALUES (?,?)`, [name, req.user.id], function (err) {
    const groupId = this.lastID;
    db.run(`INSERT INTO group_members (group_id, user_id) VALUES (?,?)`, [groupId, req.user.id]);
    if (members && members.length) {
      const stmt = db.prepare(`INSERT INTO group_members (group_id, user_id) VALUES (?,?)`);
      members.forEach(id => { if (id !== req.user.id) stmt.run(groupId, id); });
      stmt.finalize();
    }
    res.json({ success: true, group_id: groupId });
  });
});

// Get My Groups
app.get('/groups', authenticateToken, (req, res) => {
  db.all(`SELECT g.id, g.name, g.photo FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_id = ?`, [req.user.id], (err, groups) => {
    res.json(groups);
  });
});

// Get messages (personal or group)
app.get('/messages/:type/:id', authenticateToken, (req, res) => {
  const { type, id } = req.params;
  let sql, params;
  if (type === 'personal') {
    sql = `SELECT * FROM messages WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?) ORDER BY timestamp ASC`;
    params = [req.user.id, parseInt(id), parseInt(id), req.user.id];
  } else {
    sql = `SELECT * FROM messages WHERE group_id=? ORDER BY timestamp ASC`;
    params = [parseInt(id)];
  }
  db.all(sql, params, (err, msgs) => res.json(msgs));
});

// Upload any file (photo, video, voice, file)
app.post('/upload-file', authenticateToken, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ success: true, file_url: `/uploads/${req.file.filename}` });
});

// ==================== LIVE CHAT (Socket.io) ====================
io.on('connection', (socket) => {
  console.log('User connected:', socket.user.id);

  socket.on('join-room', (room) => {
    socket.join(room);
  });

  socket.on('send-message', (data) => {
    const { room, message_text, message_type = 'text', file_url = null, reply_to = null, is_group, target_id } = data;
    const sender_id = socket.user.id;

    const query = is_group 
      ? `INSERT INTO messages (sender_id, group_id, message_text, message_type, file_url, reply_to) VALUES (?,?,?,?,?,?)`
      : `INSERT INTO messages (sender_id, receiver_id, message_text, message_type, file_url, reply_to) VALUES (?,?,?,?,?,?)`;

    const params = is_group 
      ? [sender_id, target_id, message_text, message_type, file_url, reply_to]
      : [sender_id, target_id, message_text, message_type, file_url, reply_to];

    db.run(query, params, function (err) {
      if (err) return;
      const message = {
        id: this.lastID,
        sender_id,
        receiver_id: is_group ? null : target_id,
        group_id: is_group ? target_id : null,
        message_text,
        message_type,
        file_url,
        reply_to,
        timestamp: new Date().toISOString()
      };
      io.to(room).emit('receive-message', message);
    });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.user.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`CHATxHASAN Server running on port ${PORT} - SUPER FAST`));
