const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const socketIO = require('socket.io');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb+srv://your-mongodb-uri', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB Connected')).catch(err => console.log(err));

// Cloudinary Config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer setup for memory storage
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

// Schemas
const userSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  email: { type: String, unique: true },
  password: String,
  profilePhoto: { type: String, default: 'https://cdn-icons-png.flaticon.com/512/149/149071.png' },
  isActive: { type: Boolean, default: false },
  lastSeen: Date,
  socketId: String,
  fcmToken: String,
  createdAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  chatId: String,
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
  text: String,
  type: { type: String, default: 'text' },
  fileUrl: String,
  fileName: String,
  fileSize: Number,
  duration: Number,
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  reactions: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    emoji: String
  }],
  forwardedFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isDeleted: { type: Boolean, default: false },
  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

const groupSchema = new mongoose.Schema({
  name: String,
  photo: { type: String, default: 'https://cdn-icons-png.flaticon.com/512/32/32533.png' },
  admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  members: [{ 
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    role: { type: String, default: 'member' }
  }],
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const Group = mongoose.model('Group', groupSchema);

// Authentication Middleware
const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) throw new Error();
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Please authenticate' });
  }
};

// Routes
app.post('/api/register', upload.single('profilePhoto'), async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    let profilePhoto = 'https://cdn-icons-png.flaticon.com/512/149/149071.png';
    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { folder: 'chatxhasan/profiles' },
          (error, result) => error ? reject(error) : resolve(result)
        );
        uploadStream.end(req.file.buffer);
      });
      profilePhoto = result.secure_url;
    }

    const user = new User({ firstName, lastName, email, password: hashedPassword, profilePhoto });
    await user.save();
    
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'secret');
    res.json({ token, user: { ...user._doc, password: undefined } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !await bcrypt.compare(password, user.password)) {
      throw new Error('Invalid credentials');
    }
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'secret');
    res.json({ token, user: { ...user._doc, password: undefined } });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.get('/api/users', auth, async (req, res) => {
  const users = await User.find({ _id: { $ne: req.userId } }).select('-password');
  res.json(users);
});

app.get('/api/messages/:userId', auth, async (req, res) => {
  const messages = await Message.find({
    $or: [
      { senderId: req.userId, receiverId: req.params.userId },
      { senderId: req.params.userId, receiverId: req.userId }
    ],
    isDeleted: false
  }).populate('senderId', 'firstName lastName profilePhoto')
    .populate('replyTo')
    .sort({ createdAt: 1 });
  res.json(messages);
});

app.get('/api/groups', auth, async (req, res) => {
  const groups = await Group.find({ 'members.userId': req.userId })
    .populate('members.userId', 'firstName lastName profilePhoto isActive')
    .populate('admin', 'firstName lastName');
  res.json(groups);
});

app.post('/api/groups', auth, upload.single('photo'), async (req, res) => {
  try {
    const { name, members } = req.body;
    let photo = 'https://cdn-icons-png.flaticon.com/512/32/32533.png';
    
    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { folder: 'chatxhasan/groups' },
          (error, result) => error ? reject(error) : resolve(result)
        );
        uploadStream.end(req.file.buffer);
      });
      photo = result.secure_url;
    }

    const group = new Group({
      name,
      photo,
      admin: req.userId,
      members: [
        { userId: req.userId, role: 'admin' },
        ...JSON.parse(members).map(id => ({ userId: id }))
      ]
    });
    await group.save();
    
    const populatedGroup = await Group.findById(group._id)
      .populate('members.userId', 'firstName lastName profilePhoto isActive');
    res.json(populatedGroup);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/group-messages/:groupId', auth, async (req, res) => {
  const messages = await Message.find({ groupId: req.params.groupId, isDeleted: false })
    .populate('senderId', 'firstName lastName profilePhoto')
    .populate('replyTo')
    .sort({ createdAt: 1 });
  res.json(messages);
});

app.post('/api/upload', auth, upload.single('file'), async (req, res) => {
  try {
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: 'chatxhasan/files', resource_type: 'auto' },
        (error, result) => error ? reject(error) : resolve(result)
      );
      uploadStream.end(req.file.buffer);
    });
    res.json({ url: result.secure_url, fileType: result.resource_type });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Socket.IO
const activeUsers = new Map();

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  socket.on('user-online', async (userId) => {
    activeUsers.set(userId, socket.id);
    await User.findByIdAndUpdate(userId, { isActive: true, socketId: socket.id });
    io.emit('user-status', { userId, isActive: true });
  });

  socket.on('send-message', async (data) => {
    try {
      const message = new Message({
        chatId: data.chatId,
        senderId: data.senderId,
        receiverId: data.receiverId,
        groupId: data.groupId,
        text: data.text,
        type: data.type || 'text',
        fileUrl: data.fileUrl,
        fileName: data.fileName,
        fileSize: data.fileSize,
        duration: data.duration,
        replyTo: data.replyTo
      });
      await message.save();
      
      const populatedMessage = await Message.findById(message._id)
        .populate('senderId', 'firstName lastName profilePhoto')
        .populate('replyTo');
      
      if (data.groupId) {
        const group = await Group.findById(data.groupId).populate('members.userId');
        group.members.forEach(member => {
          const memberSocketId = activeUsers.get(member.userId._id.toString());
          if (memberSocketId && member.userId._id.toString() !== data.senderId) {
            io.to(memberSocketId).emit('new-message', populatedMessage);
          }
        });
      } else if (data.receiverId) {
        const receiverSocketId = activeUsers.get(data.receiverId);
        if (receiverSocketId) {
          io.to(receiverSocketId).emit('new-message', populatedMessage);
        }
      }
      
      socket.emit('message-sent', populatedMessage);
    } catch (error) {
      socket.emit('message-error', { error: error.message });
    }
  });

  socket.on('typing', (data) => {
    if (data.receiverId) {
      const receiverSocketId = activeUsers.get(data.receiverId);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('user-typing', { userId: data.senderId, isTyping: data.isTyping });
      }
    } else if (data.groupId) {
      socket.to(data.groupId).emit('user-typing-group', { 
        groupId: data.groupId, 
        userId: data.senderId, 
        isTyping: data.isTyping 
      });
    }
  });

  socket.on('message-reaction', async (data) => {
    const message = await Message.findById(data.messageId);
    if (message) {
      const existingReaction = message.reactions.find(r => r.userId.toString() === data.userId);
      if (existingReaction) {
        if (data.emoji) {
          existingReaction.emoji = data.emoji;
        } else {
          message.reactions = message.reactions.filter(r => r.userId.toString() !== data.userId);
        }
      } else if (data.emoji) {
        message.reactions.push({ userId: data.userId, emoji: data.emoji });
      }
      await message.save();
      io.emit('message-reaction-updated', { messageId: data.messageId, reactions: message.reactions });
    }
  });

  socket.on('disconnect', async () => {
    let userId;
    for (let [key, value] of activeUsers) {
      if (value === socket.id) {
        userId = key;
        activeUsers.delete(key);
        break;
      }
    }
    if (userId) {
      await User.findByIdAndUpdate(userId, { isActive: false, lastSeen: new Date() });
      io.emit('user-status', { userId, isActive: false, lastSeen: new Date() });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
