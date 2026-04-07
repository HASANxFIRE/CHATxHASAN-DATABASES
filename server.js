const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'chatxhasan-secret-key-2024';
const DATA_DIR = path.join(__dirname, 'data');

// Initialize data directory and files
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const DB = {
  users: path.join(DATA_DIR, 'users.json'),
  messages: path.join(DATA_DIR, 'messages.json'),
  groups: path.join(DATA_DIR, 'groups.json'),
  uploads: path.join(DATA_DIR, 'uploads')
};

// Initialize files
['users.json', 'messages.json', 'groups.json'].forEach(file => {
  const filePath = path.join(DATA_DIR, file);
  if (!fs.existsSync(filePath)) fs.writeJsonSync(filePath, file === 'users.json' ? [] : file === 'messages.json' ? [] : []);
});

if (!fs.existsSync(DB.uploads)) fs.mkdirSync(DB.uploads);

// Storage for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DB.uploads),
  filename: (req, file, cb) => cb(null, Date.now() + '_' + uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// Serve uploaded files
app.use('/uploads', express.static(DB.uploads));

// Auth Middleware
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ============ API Routes ============

// Register
app.post('/api/register', async (req, res) => {
  const { firstName, lastName, email, password, profilePhoto } = req.body;
  const users = fs.readJsonSync(DB.users);
  if (users.find(u => u.email === email)) {
    return res.status(400).json({ error: 'Email already exists' });
  }
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    firstName, lastName, email,
    password: hashedPassword,
    profilePhoto: profilePhoto || 'https://ui-avatars.com/api/?name=' + firstName + '+' + lastName + '&background=6366f1&color=fff&size=128',
    active: false,
    lastSeen: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  users.push(user);
  fs.writeJsonSync(DB.users, users);
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
  const { password: _, ...userWithoutPassword } = user;
  res.json({ user: userWithoutPassword, token });
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const users = fs.readJsonSync(DB.users);
  const user = users.find(u => u.email === email);
  if (!user || !await bcrypt.compare(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
  const { password: _, ...userWithoutPassword } = user;
  res.json({ user: userWithoutPassword, token });
});

// Get Users
app.get('/api/users', authenticate, (req, res) => {
  const users = fs.readJsonSync(DB.users);
  res.json(users.map(({ password, ...u }) => u));
});

// Get Messages between users
app.get('/api/messages/:userId', authenticate, (req, res) => {
  const messages = fs.readJsonSync(DB.messages);
  const userMessages = messages.filter(m => 
    (m.senderId === req.user.id && m.receiverId === req.params.userId) ||
    (m.senderId === req.params.userId && m.receiverId === req.user.id)
  ).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json(userMessages);
});

// Get Group Messages
app.get('/api/group-messages/:groupId', authenticate, (req, res) => {
  const messages = fs.readJsonSync(DB.messages);
  const groupMessages = messages.filter(m => m.groupId === req.params.groupId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json(groupMessages);
});

// Send Message
app.post('/api/messages', authenticate, (req, res) => {
  const messages = fs.readJsonSync(DB.messages);
  const message = {
    id: uuidv4(),
    senderId: req.user.id,
    receiverId: req.body.receiverId,
    groupId: req.body.groupId || null,
    text: req.body.text || '',
    type: req.body.type || 'text',
    fileUrl: req.body.fileUrl || null,
    fileName: req.body.fileName || null,
    fileSize: req.body.fileSize || null,
    replyTo: req.body.replyTo || null,
    reactions: {},
    read: false,
    createdAt: new Date().toISOString()
  };
  messages.push(message);
  fs.writeJsonSync(DB.messages, messages);
  
  // Emit via socket
  if (message.groupId) {
    io.to('group_' + message.groupId).emit('new_group_message', message);
  } else {
    io.to('user_' + message.receiverId).emit('new_message', message);
    io.to('user_' + message.senderId).emit('new_message', message);
  }
  
  res.json(message);
});

// Upload File
app.post('/api/upload', authenticate, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ fileUrl, fileName: req.file.originalname, fileSize: req.file.size });
});

// Create Group
app.post('/api/groups', authenticate, (req, res) => {
  const groups = fs.readJsonSync(DB.groups);
  const group = {
    id: uuidv4(),
    name: req.body.name,
    groupPhoto: req.body.groupPhoto || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(req.body.name) + '&background=8b5cf6&color=fff&size=128',
    members: [...req.body.members, req.user.id],
    admins: [req.user.id],
    createdBy: req.user.id,
    createdAt: new Date().toISOString()
  };
  groups.push(group);
  fs.writeJsonSync(DB.groups, groups);
  res.json(group);
});

// Get User Groups
app.get('/api/groups', authenticate, (req, res) => {
  const groups = fs.readJsonSync(DB.groups);
  res.json(groups.filter(g => g.members.includes(req.user.id)));
});

// Update User Active Status
app.put('/api/users/active', authenticate, (req, res) => {
  const users = fs.readJsonSync(DB.users);
  const userIndex = users.findIndex(u => u.id === req.user.id);
  if (userIndex !== -1) {
    users[userIndex].active = req.body.active;
    users[userIndex].lastSeen = new Date().toISOString();
    fs.writeJsonSync(DB.users, users);
    io.emit('user_status', { userId: req.user.id, active: req.body.active, lastSeen: users[userIndex].lastSeen });
  }
  res.json({ success: true });
});

// Add Reaction to Message
app.put('/api/messages/:messageId/reaction', authenticate, (req, res) => {
  const messages = fs.readJsonSync(DB.messages);
  const message = messages.find(m => m.id === req.params.messageId);
  if (message) {
    if (!message.reactions) message.reactions = {};
    message.reactions[req.user.id] = req.body.reaction;
    fs.writeJsonSync(DB.messages, messages);
    
    if (message.groupId) {
      io.to('group_' + message.groupId).emit('message_reaction', { messageId: message.id, reactions: message.reactions });
    } else {
      io.to('user_' + message.senderId).emit('message_reaction', { messageId: message.id, reactions: message.reactions });
      io.to('user_' + message.receiverId).emit('message_reaction', { messageId: message.id, reactions: message.reactions });
    }
  }
  res.json({ success: true });
});

// ============ Socket.IO ============
const userSockets = new Map();

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);
  
  socket.on('register_user', (userId) => {
    userSockets.set(userId, socket.id);
    socket.join('user_' + userId);
    
    // Update user active status
    const users = fs.readJsonSync(DB.users);
    const user = users.find(u => u.id === userId);
    if (user) {
      user.active = true;
      user.lastSeen = new Date().toISOString();
      fs.writeJsonSync(DB.users, users);
      io.emit('user_status', { userId, active: true, lastSeen: user.lastSeen });
    }
  });
  
  socket.on('join_group', (groupId) => {
    socket.join('group_' + groupId);
  });
  
  socket.on('typing', ({ receiverId, groupId, isTyping }) => {
    if (groupId) {
      socket.to('group_' + groupId).emit('user_typing', { userId: socket.userId, isTyping });
    } else if (receiverId) {
      const receiverSocket = userSockets.get(receiverId);
      if (receiverSocket) {
        io.to(receiverSocket).emit('user_typing', { userId: socket.userId, isTyping });
      }
    }
  });
  
  socket.on('disconnect', () => {
    let disconnectedUserId = null;
    for (const [userId, socketId] of userSockets) {
      if (socketId === socket.id) {
        disconnectedUserId = userId;
        userSockets.delete(userId);
        break;
      }
    }
    if (disconnectedUserId) {
      const users = fs.readJsonSync(DB.users);
      const user = users.find(u => u.id === disconnectedUserId);
      if (user) {
        user.active = false;
        user.lastSeen = new Date().toISOString();
        fs.writeJsonSync(DB.users, users);
        io.emit('user_status', { userId: disconnectedUserId, active: false, lastSeen: user.lastSeen });
      }
    }
  });
});

server.listen(PORT, () => console.log(`CHATxHASAN Server running on port ${PORT}`));
