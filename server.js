const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = 'chatxhasan-super-secret-2026';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Uploads folder
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Database
const db = new sqlite3.Database('./chatxhasan.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    profile_photo TEXT DEFAULT 'https://picsum.photos/id/64/200/200',
    last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    is_group INTEGER DEFAULT 0,
    sender_id INTEGER NOT NULL,
    content TEXT,
    file_url TEXT,
    file_type TEXT DEFAULT 'text',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    reply_to INTEGER,
    reactions TEXT DEFAULT '[]'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    photo TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER,
    user_id INTEGER,
    PRIMARY KEY (group_id, user_id)
  )`);
});

const authenticateToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Register
app.post('/register', async (req, res) => {
  const { first_name, last_name, email, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  db.run('INSERT INTO users (first_name, last_name, email, password_hash) VALUES (?,?,?,?)',
    [first_name, last_name, email, hash], function(err) {
      if (err) return res.status(400).json({error: err.message});
      const token = jwt.sign({id: this.lastID, email}, SECRET);
      res.json({success: true, token, user: {id: this.lastID, first_name, last_name, email, profile_photo: 'https://picsum.photos/id/64/200/200'}});
    });
});

// Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email=?', [email], async (err, user) => {
    if (err || !user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({error: 'Invalid credentials'});
    db.run('UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE id=?', [user.id]);
    const token = jwt.sign({id: user.id, email: user.email}, SECRET);
    res.json({success: true, token, user: {id: user.id, first_name: user.first_name, last_name: user.last_name, profile_photo: user.profile_photo}});
  });
});

// Upload profile photo
app.post('/upload-profile', authenticateToken, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({error: 'No file'});
  const url = `/uploads/${req.file.filename}`;
  db.run('UPDATE users SET profile_photo=? WHERE id=?', [url, req.user.id], () => {
    res.json({success: true, profile_photo: url});
  });
});

// Active users
app.get('/active-users', authenticateToken, (req, res) => {
  db.all(`SELECT id, first_name, last_name, profile_photo,
          CASE WHEN last_active > datetime('now', '-5 minutes') THEN 1 ELSE 0 END as is_active 
          FROM users WHERE id != ?`, [req.user.id], (err, rows) => res.json(rows));
});

// Send message (text + file)
app.post('/send-message', authenticateToken, upload.single('file'), (req, res) => {
  const { chat_id, content, is_group = 0, reply_to } = req.body;
  let file_url = null, file_type = 'text';
  if (req.file) {
    file_url = `/uploads/${req.file.filename}`;
    const mime = req.file.mimetype;
    if (mime.startsWith('image')) file_type = 'image';
    else if (mime.startsWith('video')) file_type = 'video';
    else if (mime.includes('audio')) file_type = 'voice';
    else file_type = 'file';
  }
  db.run(`INSERT INTO messages (chat_id, is_group, sender_id, content, file_url, file_type, reply_to) 
          VALUES (?,?,?,?,?,?,?)`, [chat_id, is_group, req.user.id, content || '', file_url, file_type, reply_to || null],
    function(err) {
      if (err) return res.status(500).json({error: err.message});
      res.json({success: true, message_id: this.lastID});
    });
});

// Get messages (polling – live chat)
app.get('/messages/:chat_id', authenticateToken, (req, res) => {
  const last_id = req.query.last_id || 0;
  db.all('SELECT * FROM messages WHERE chat_id=? AND id > ? ORDER BY timestamp ASC',
    [req.params.chat_id, last_id], (err, rows) => res.json(rows));
});

// Reaction
app.post('/react', authenticateToken, (req, res) => {
  const { message_id, reaction } = req.body;
  db.get('SELECT reactions FROM messages WHERE id=?', [message_id], (err, row) => {
    if (err || !row) return res.status(404).json({error: 'Not found'});
    let reactions = JSON.parse(row.reactions || '[]');
    if (!reactions.includes(reaction)) reactions.push(reaction);
    db.run('UPDATE messages SET reactions=? WHERE id=?', [JSON.stringify(reactions), message_id], () => res.json({success: true}));
  });
});

// Create group
app.post('/create-group', authenticateToken, (req, res) => {
  const { name, members = [] } = req.body;
  db.run('INSERT INTO groups (name, created_by) VALUES (?,?)', [name, req.user.id], function(err) {
    if (err) return res.status(500).json({error: err.message});
    const group_id = this.lastID;
    const stmt = db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?,?)');
    stmt.run(group_id, req.user.id);
    members.forEach(id => { if (id != req.user.id) stmt.run(group_id, id); });
    stmt.finalize();
    res.json({success: true, group_id});
  });
});

// My chats & groups
app.get('/my-chats', authenticateToken, (req, res) => {
  db.all(`SELECT g.id as chat_id, g.name, g.photo, 1 as is_group,
          (SELECT content FROM messages WHERE chat_id = g.id ORDER BY timestamp DESC LIMIT 1) as last_message
          FROM groups g JOIN group_members gm ON g.id=gm.group_id WHERE gm.user_id=?`, [req.user.id],
    (err, groups) => res.json({groups, personal: []})); // personal chat_id = p{min}_{max}
});

app.listen(PORT, () => console.log(`CHATxHASAN Server running on ${PORT}`));
