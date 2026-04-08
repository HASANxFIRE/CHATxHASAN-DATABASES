const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// Create uploads directory if not exists
fs.ensureDirSync('./uploads/profiles');
fs.ensureDirSync('./uploads/messages');
fs.ensureDirSync('./uploads/voices');

// Multer configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let folder = 'uploads/';
    if (file.fieldname === 'profilePhoto') folder += 'profiles/';
    else if (file.fieldname === 'messageFile') folder += 'messages/';
    else if (file.fieldname === 'voiceMessage') folder += 'voices/';
    cb(null, folder);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + uuidv4() + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// JWT Secret
const JWT_SECRET = 'chatxhasan_super_secret_key_2024';

// Middleware to verify token
const verifyToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ============= AUTH ROUTES =============

// Register user
app.post('/api/register', async (req, res) => {
  const { firstName, lastName, email, password, profilePhoto } = req.body;
  
  try {
    // Check if user exists
    const existingUser = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    
    // Insert user
    await db.run(
      'INSERT INTO users (id, first_name, last_name, email, password, profile_photo, status, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, firstName, lastName, email, hashedPassword, profilePhoto || 'https://ui-avatars.com/api/?background=random&name=' + firstName + '+' + lastName, 'offline', Date.now()]
    );
    
    // Generate token
    const token = jwt.sign({ userId: userId }, JWT_SECRET, { expiresIn: '30d' });
    
    res.json({ 
      success: true, 
      token, 
      user: { id: userId, firstName, lastName, email, profilePhoto: profilePhoto || 'https://ui-avatars.com/api/?background=random&name=' + firstName + '+' + lastName }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login user
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid password' });
    }
    
    // Update status
    await db.run('UPDATE users SET status = ?, last_seen = ? WHERE id = ?', ['online', Date.now(), user.id]);
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    
    res.json({ 
      success: true, 
      token, 
      user: { 
        id: user.id, 
        firstName: user.first_name, 
        lastName: user.last_name, 
        email: user.email, 
        profilePhoto: user.profile_photo,
        status: user.status
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user by token
app.get('/api/me', verifyToken, async (req, res) => {
  try {
    const user = await db.get('SELECT id, first_name, last_name, email, profile_photo, status, last_seen FROM users WHERE id = ?', [req.userId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ 
      id: user.id, 
      firstName: user.first_name, 
      lastName: user.last_name, 
      email: user.email, 
      profilePhoto: user.profile_photo,
      status: user.status,
      lastSeen: user.last_seen
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============= USER ROUTES =============

// Get all users except current
app.get('/api/users', verifyToken, async (req, res) => {
  try {
    const users = await db.all('SELECT id, first_name, last_name, email, profile_photo, status, last_seen FROM users WHERE id != ?', [req.userId]);
    res.json(users.map(u => ({
      id: u.id,
      firstName: u.first_name,
      lastName: u.last_name,
      email: u.email,
      profilePhoto: u.profile_photo,
      status: u.status,
      lastSeen: u.last_seen
    })));
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user by ID
app.get('/api/users/:id', verifyToken, async (req, res) => {
  try {
    const user = await db.get('SELECT id, first_name, last_name, email, profile_photo, status, last_seen FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      profilePhoto: user.profile_photo,
      status: user.status,
      lastSeen: user.last_seen
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload profile photo
app.post('/api/upload/profile', verifyToken, upload.single('profilePhoto'), async (req, res) => {
  try {
    const photoUrl = `${req.protocol}://${req.get('host')}/uploads/profiles/${req.file.filename}`;
    await db.run('UPDATE users SET profile_photo = ? WHERE id = ?', [photoUrl, req.userId]);
    res.json({ success: true, url: photoUrl });
  } catch (error) {
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ============= CHAT ROUTES =============

// Create or get private chat
app.post('/api/chat/private', verifyToken, async (req, res) => {
  const { otherUserId } = req.body;
  
  try {
    // Check if chat exists
    let chat = await db.get(
      'SELECT * FROM chats WHERE type = "private" AND (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)',
      [req.userId, otherUserId, otherUserId, req.userId]
    );
    
    if (!chat) {
      const chatId = uuidv4();
      await db.run(
        'INSERT INTO chats (id, type, user1_id, user2_id, created_at) VALUES (?, ?, ?, ?, ?)',
        [chatId, 'private', req.userId, otherUserId, Date.now()]
      );
      chat = { id: chatId, type: 'private' };
    }
    
    res.json({ chatId: chat.id });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create group chat
app.post('/api/chat/group', verifyToken, async (req, res) => {
  const { groupName, members } = req.body;
  
  try {
    const groupId = uuidv4();
    await db.run(
      'INSERT INTO chats (id, type, group_name, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      [groupId, 'group', groupName, req.userId, Date.now()]
    );
    
    // Add members
    const allMembers = [...members, req.userId];
    for (const memberId of allMembers) {
      await db.run(
        'INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)',
        [groupId, memberId, Date.now()]
      );
    }
    
    // Add group photo
    await db.run(
      'INSERT INTO group_photos (group_id, photo_url) VALUES (?, ?)',
      [groupId, 'https://ui-avatars.com/api/?background=random&name=' + groupName]
    );
    
    res.json({ groupId, success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user chats
app.get('/api/chats', verifyToken, async (req, res) => {
  try {
    const chats = await db.all(`
      SELECT DISTINCT 
        c.id, c.type, c.group_name, c.user1_id, c.user2_id,
        (
          SELECT m.content FROM messages m 
          WHERE m.chat_id = c.id 
          ORDER BY m.created_at DESC LIMIT 1
        ) as last_message,
        (
          SELECT m.created_at FROM messages m 
          WHERE m.chat_id = c.id 
          ORDER BY m.created_at DESC LIMIT 1
        ) as last_message_time
      FROM chats c
      LEFT JOIN chat_members cm ON c.id = cm.chat_id
      WHERE c.user1_id = ? OR c.user2_id = ? OR cm.user_id = ?
      ORDER BY last_message_time DESC
    `, [req.userId, req.userId, req.userId]);
    
    const enrichedChats = [];
    for (const chat of chats) {
      if (chat.type === 'private') {
        const otherUserId = chat.user1_id === req.userId ? chat.user2_id : chat.user1_id;
        const otherUser = await db.get('SELECT id, first_name, last_name, profile_photo, status FROM users WHERE id = ?', [otherUserId]);
        enrichedChats.push({
          id: chat.id,
          type: 'private',
          name: `${otherUser.first_name} ${otherUser.last_name}`,
          photo: otherUser.profile_photo,
          status: otherUser.status,
          lastMessage: chat.last_message,
          lastMessageTime: chat.last_message_time
        });
      } else {
        const groupPhoto = await db.get('SELECT photo_url FROM group_photos WHERE group_id = ?', [chat.id]);
        enrichedChats.push({
          id: chat.id,
          type: 'group',
          name: chat.group_name,
          photo: groupPhoto ? groupPhoto.photo_url : 'https://ui-avatars.com/api/?background=random&name=' + chat.group_name,
          lastMessage: chat.last_message,
          lastMessageTime: chat.last_message_time
        });
      }
    }
    
    res.json(enrichedChats);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get chat messages
app.get('/api/messages/:chatId', verifyToken, async (req, res) => {
  const { chatId } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  const before = req.query.before;
  
  try {
    let query = 'SELECT * FROM messages WHERE chat_id = ?';
    let params = [chatId];
    
    if (before) {
      query += ' AND created_at < ?';
      params.push(parseInt(before));
    }
    
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    
    const messages = await db.all(query, params);
    res.json(messages.reverse());
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload message file
app.post('/api/upload/message', verifyToken, upload.single('messageFile'), async (req, res) => {
  try {
    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/messages/${req.file.filename}`;
    res.json({ success: true, url: fileUrl, type: req.file.mimetype });
  } catch (error) {
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Upload voice message
app.post('/api/upload/voice', verifyToken, upload.single('voiceMessage'), async (req, res) => {
  try {
    const voiceUrl = `${req.protocol}://${req.get('host')}/uploads/voices/${req.file.filename}`;
    res.json({ success: true, url: voiceUrl });
  } catch (error) {
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Block user
app.post('/api/block/:userId', verifyToken, async (req, res) => {
  try {
    await db.run(
      'INSERT INTO blocked_users (user_id, blocked_user_id, created_at) VALUES (?, ?, ?)',
      [req.userId, req.params.userId, Date.now()]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete chat
app.delete('/api/chat/:chatId', verifyToken, async (req, res) => {
  try {
    await db.run('DELETE FROM messages WHERE chat_id = ?', [req.params.chatId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============= SOCKET.IO =============

// Store online users
const onlineUsers = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication error'));
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.userId}`);
  
  // Add to online users
  onlineUsers.set(socket.userId, socket.id);
  db.run('UPDATE users SET status = "online", last_seen = ? WHERE id = ?', [Date.now(), socket.userId]);
  
  // Broadcast online status
  io.emit('user_status', { userId: socket.userId, status: 'online' });
  
  // Join user to their rooms
  socket.join(`user_${socket.userId}`);
  
  // Handle join chat room
  socket.on('join_chat', (chatId) => {
    socket.join(`chat_${chatId}`);
    console.log(`User ${socket.userId} joined chat ${chatId}`);
  });
  
  // Handle leave chat room
  socket.on('leave_chat', (chatId) => {
    socket.leave(`chat_${chatId}`);
  });
  
  // Handle send message
  socket.on('send_message', async (data) => {
    try {
      const { chatId, content, type, replyTo, fileUrl, fileName } = data;
      const messageId = uuidv4();
      const timestamp = Date.now();
      
      // Save to database
      await db.run(
        'INSERT INTO messages (id, chat_id, sender_id, content, type, reply_to, file_url, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [messageId, chatId, socket.userId, content, type || 'text', replyTo || null, fileUrl || null, fileName || null, timestamp]
      );
      
      const message = {
        id: messageId,
        chatId,
        senderId: socket.userId,
        content,
        type: type || 'text',
        replyTo,
        fileUrl,
        fileName,
        createdAt: timestamp
      };
      
      // Get sender info
      const sender = await db.get('SELECT id, first_name, last_name, profile_photo FROM users WHERE id = ?', [socket.userId]);
      message.sender = {
        id: sender.id,
        firstName: sender.first_name,
        lastName: sender.last_name,
        profilePhoto: sender.profile_photo
      };
      
      // Emit to chat room
      io.to(`chat_${chatId}`).emit('new_message', message);
      
      // Send notification to offline users
      const chatMembers = await db.all('SELECT user_id FROM chat_members WHERE chat_id = ?', [chatId]);
      for (const member of chatMembers) {
        if (member.user_id !== socket.userId) {
          const userSocket = onlineUsers.get(member.user_id);
          if (!userSocket) {
            // User is offline, store for push notification
            await db.run(
              'INSERT INTO notifications (user_id, message_id, chat_id, created_at) VALUES (?, ?, ?, ?)',
              [member.user_id, messageId, chatId, timestamp]
            );
          }
        }
      }
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('message_error', { error: 'Failed to send message' });
    }
  });
  
  // Handle typing indicator
  socket.on('typing', ({ chatId, isTyping }) => {
    socket.to(`chat_${chatId}`).emit('user_typing', { userId: socket.userId, isTyping });
  });
  
  // Handle message reaction
  socket.on('add_reaction', async ({ messageId, reaction }) => {
    try {
      await db.run(
        'INSERT OR REPLACE INTO message_reactions (message_id, user_id, reaction, created_at) VALUES (?, ?, ?, ?)',
        [messageId, socket.userId, reaction, Date.now()]
      );
      
      // Get chat_id for the message
      const message = await db.get('SELECT chat_id FROM messages WHERE id = ?', [messageId]);
      if (message) {
        io.to(`chat_${message.chat_id}`).emit('message_reaction', { messageId, userId: socket.userId, reaction });
      }
    } catch (error) {
      console.error('Error adding reaction:', error);
    }
  });
  
  // Handle message forward
  socket.on('forward_message', async ({ messageId, targetChatId }) => {
    try {
      const originalMessage = await db.get('SELECT * FROM messages WHERE id = ?', [messageId]);
      if (originalMessage) {
        const newMessageId = uuidv4();
        await db.run(
          'INSERT INTO messages (id, chat_id, sender_id, content, type, file_url, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [newMessageId, targetChatId, socket.userId, originalMessage.content, originalMessage.type, originalMessage.file_url, originalMessage.file_name, Date.now()]
        );
        
        const forwardedMessage = {
          id: newMessageId,
          chatId: targetChatId,
          senderId: socket.userId,
          content: originalMessage.content,
          type: originalMessage.type,
          fileUrl: originalMessage.file_url,
          fileName: originalMessage.file_name,
          createdAt: Date.now()
        };
        
        io.to(`chat_${targetChatId}`).emit('new_message', forwardedMessage);
      }
    } catch (error) {
      console.error('Error forwarding message:', error);
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.userId}`);
    onlineUsers.delete(socket.userId);
    db.run('UPDATE users SET status = "offline", last_seen = ? WHERE id = ?', [Date.now(), socket.userId]);
    io.emit('user_status', { userId: socket.userId, status: 'offline' });
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
