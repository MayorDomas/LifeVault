require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const bcrypt = require('bcrypt');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Config ---
const IDEA_CATEGORIES = ['general', 'project', 'work', 'personal', 'shopping'];
const FILE_CATEGORIES = ['documents', 'images', 'code', '3d-models', 'other'];
const TIMELINE_CATEGORIES = ['personal', 'work', 'health', 'finance', 'milestone', 'other'];
const DATA_DIR = path.join(__dirname, 'data');
const IDEAS_FILE = path.join(DATA_DIR, 'ideas.json');
const IDEAS_HISTORY_FILE = path.join(DATA_DIR, 'ideas-history.json');
const TIMELINE_FILE = path.join(DATA_DIR, 'timeline.json');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const SENT_NOTIFICATIONS_FILE = path.join(DATA_DIR, 'sent-notifications.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
FILE_CATEGORIES.forEach(cat => {
  const dir = path.join(UPLOAD_DIR, cat);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- VAPID setup ---
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:user@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// --- Hash password on startup ---
let hashedPassword = null;
(async () => {
  const raw = process.env.PASSWORD || 'vault2024';
  hashedPassword = await bcrypt.hash(raw, 10);
})();

// --- Middleware ---
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production' ? true : false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  },
  proxy: process.env.NODE_ENV === 'production'
}));

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(express.static(path.join(__dirname, 'public')));

// --- Data Helpers ---
function readJSON(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const data = fs.readFileSync(file, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// --- Auth Middleware (dual: session OR API key) ---
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token === process.env.API_KEY) return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// --- Multer setup (from FileVault) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const category = req.body.category || 'other';
    const safe = FILE_CATEGORIES.includes(category) ? category : 'other';
    const dir = path.join(UPLOAD_DIR, safe);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const target = path.join(UPLOAD_DIR, req.body.category || 'other', original);
    if (fs.existsSync(target)) {
      const ext = path.extname(original);
      const name = path.basename(original, ext);
      cb(null, `${name}_${Date.now()}${ext}`);
    } else {
      cb(null, original);
    }
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE }
});

// ==========================================
// AUTH ROUTES
// ==========================================

app.post('/api/login', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || !hashedPassword) {
      return res.status(400).json({ error: 'Password required' });
    }
    const match = await bcrypt.compare(password, hashedPassword);
    if (match) {
      req.session.authenticated = true;
      res.json({ success: true });
    } else {
      res.status(401).json({ error: 'Wrong password' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/auth', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ==========================================
// IDEAS ROUTES (from IdeaVault)
// ==========================================

app.post('/api/ideas', requireAuth, (req, res) => {
  try {
    const { text, category } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Idea text is required' });
    }
    const safeCat = IDEA_CATEGORIES.includes(category) ? category : 'general';
    const idea = {
      id: uuidv4(),
      text: text.trim(),
      category: safeCat,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const ideas = readJSON(IDEAS_FILE);
    ideas.unshift(idea);
    writeJSON(IDEAS_FILE, ideas);
    res.json({ success: true, idea });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save idea' });
  }
});

app.get('/api/ideas', requireAuth, (req, res) => {
  try {
    let ideas = readJSON(IDEAS_FILE);
    const { category, search } = req.query;
    if (category && category !== 'all') {
      ideas = ideas.filter(i => i.category === category);
    }
    if (search) {
      const q = search.toLowerCase();
      ideas = ideas.filter(i => i.text.toLowerCase().includes(q));
    }
    res.json({ ideas, categories: IDEA_CATEGORIES });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load ideas' });
  }
});

app.put('/api/ideas/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { text, category } = req.body;
    const ideas = readJSON(IDEAS_FILE);
    const idx = ideas.findIndex(i => i.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Idea not found' });
    if (text !== undefined) ideas[idx].text = text.trim();
    if (category !== undefined) {
      ideas[idx].category = IDEA_CATEGORIES.includes(category) ? category : ideas[idx].category;
    }
    ideas[idx].updatedAt = new Date().toISOString();
    writeJSON(IDEAS_FILE, ideas);
    res.json({ success: true, idea: ideas[idx] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update idea' });
  }
});

app.delete('/api/ideas/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    let ideas = readJSON(IDEAS_FILE);
    const deleted = ideas.find(i => i.id === id);
    if (!deleted) return res.status(404).json({ error: 'Idea not found' });
    ideas = ideas.filter(i => i.id !== id);
    writeJSON(IDEAS_FILE, ideas);
    // Save to history
    const history = readJSON(IDEAS_HISTORY_FILE);
    deleted.deletedAt = new Date().toISOString();
    history.unshift(deleted);
    writeJSON(IDEAS_HISTORY_FILE, history);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete idea' });
  }
});

// Get ideas history
app.get('/api/ideas/history', requireAuth, (req, res) => {
  try {
    const history = readJSON(IDEAS_HISTORY_FILE);
    res.json({ ideas: history });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load history' });
  }
});

// Restore idea from history
app.post('/api/ideas/history/:id/restore', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    let history = readJSON(IDEAS_HISTORY_FILE);
    const idea = history.find(i => i.id === id);
    if (!idea) return res.status(404).json({ error: 'Idea not found in history' });
    history = history.filter(i => i.id !== id);
    writeJSON(IDEAS_HISTORY_FILE, history);
    delete idea.deletedAt;
    idea.updatedAt = new Date().toISOString();
    const ideas = readJSON(IDEAS_FILE);
    ideas.unshift(idea);
    writeJSON(IDEAS_FILE, ideas);
    res.json({ success: true, idea });
  } catch (err) {
    res.status(500).json({ error: 'Failed to restore idea' });
  }
});

// ==========================================
// FILES ROUTES (from FileVault)
// ==========================================

app.post('/api/upload', requireAuth, upload.array('files', 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }
  const uploaded = req.files.map(f => ({
    name: f.filename,
    size: f.size,
    category: req.body.category || 'other'
  }));
  res.json({ success: true, files: uploaded });
});

app.get('/api/files', requireAuth, (req, res) => {
  try {
    const category = req.query.category;
    const cats = category && category !== 'all' ? [category] : FILE_CATEGORIES;
    const allFiles = [];

    cats.forEach(cat => {
      const dir = path.join(UPLOAD_DIR, cat);
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      files.forEach(filename => {
        if (filename === '.gitkeep') return;
        const filepath = path.join(dir, filename);
        const stat = fs.statSync(filepath);
        allFiles.push({
          name: filename,
          category: cat,
          size: stat.size,
          modified: stat.mtime,
          type: path.extname(filename).toLowerCase()
        });
      });
    });

    allFiles.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    res.json({ files: allFiles, categories: FILE_CATEGORIES });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list files' });
  }
});

app.get('/api/download/:category/:filename', requireAuth, (req, res) => {
  const { category, filename } = req.params;
  if (!FILE_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Invalid category' });
  }
  const safeName = path.basename(filename);
  const filepath = path.join(UPLOAD_DIR, category, safeName);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(filepath, safeName);
});

app.delete('/api/files/:category/:filename', requireAuth, (req, res) => {
  const { category, filename } = req.params;
  if (!FILE_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Invalid category' });
  }
  const safeName = path.basename(filename);
  const filepath = path.join(UPLOAD_DIR, category, safeName);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  fs.unlinkSync(filepath);
  res.json({ success: true });
});

// ==========================================
// TIMELINE ROUTES (NEW)
// ==========================================

app.post('/api/timeline', requireAuth, (req, res) => {
  try {
    const { title, description, date, time, category, notify } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }
    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }
    const safeCat = TIMELINE_CATEGORIES.includes(category) ? category : 'other';
    const event = {
      id: uuidv4(),
      title: title.trim(),
      description: (description || '').trim(),
      date,
      time: time || '',
      category: safeCat,
      completed: false,
      notify: notify !== false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const events = readJSON(TIMELINE_FILE);
    events.unshift(event);
    writeJSON(TIMELINE_FILE, events);
    res.json({ success: true, event });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save event' });
  }
});

app.get('/api/timeline', requireAuth, (req, res) => {
  try {
    let events = readJSON(TIMELINE_FILE);
    const { year, month } = req.query;
    if (year) {
      events = events.filter(e => e.date && e.date.startsWith(year));
    }
    if (year && month) {
      const prefix = `${year}-${month.padStart(2, '0')}`;
      events = events.filter(e => e.date && e.date.startsWith(prefix));
    }
    events.sort((a, b) => {
      if (a.date === b.date) {
        return (a.time || '').localeCompare(b.time || '');
      }
      return a.date.localeCompare(b.date);
    });
    res.json({ events, categories: TIMELINE_CATEGORIES });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load timeline' });
  }
});

app.put('/api/timeline/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, date, time, category, completed, notify } = req.body;
    const events = readJSON(TIMELINE_FILE);
    const idx = events.findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Event not found' });
    if (title !== undefined) events[idx].title = title.trim();
    if (description !== undefined) events[idx].description = description.trim();
    if (date !== undefined) events[idx].date = date;
    if (time !== undefined) events[idx].time = time;
    if (category !== undefined) {
      events[idx].category = TIMELINE_CATEGORIES.includes(category) ? category : events[idx].category;
    }
    if (completed !== undefined) events[idx].completed = !!completed;
    if (notify !== undefined) events[idx].notify = !!notify;
    events[idx].updatedAt = new Date().toISOString();
    writeJSON(TIMELINE_FILE, events);
    res.json({ success: true, event: events[idx] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update event' });
  }
});

app.delete('/api/timeline/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    let events = readJSON(TIMELINE_FILE);
    const before = events.length;
    events = events.filter(e => e.id !== id);
    if (events.length === before) return res.status(404).json({ error: 'Event not found' });
    writeJSON(TIMELINE_FILE, events);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// ==========================================
// PUSH NOTIFICATION ROUTES (NEW)
// ==========================================

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  try {
    const subscription = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    const subs = readJSON(SUBSCRIPTIONS_FILE);
    const exists = subs.find(s => s.endpoint === subscription.endpoint);
    if (!exists) {
      subs.push(subscription);
      writeJSON(SUBSCRIPTIONS_FILE, subs);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  try {
    const { endpoint } = req.body;
    let subs = readJSON(SUBSCRIPTIONS_FILE);
    subs = subs.filter(s => s.endpoint !== endpoint);
    writeJSON(SUBSCRIPTIONS_FILE, subs);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove subscription' });
  }
});

// Test push notification
app.post('/api/push/test', requireAuth, (req, res) => {
  try {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return res.status(400).json({ error: 'VAPID keys not configured' });
    }
    const subs = readJSON(SUBSCRIPTIONS_FILE);
    if (subs.length === 0) {
      return res.status(400).json({ error: 'No subscriptions found. Allow notifications first.' });
    }
    const payload = JSON.stringify({
      title: 'Life Vault - Test',
      body: 'Push notifications are working!',
      tag: 'test-' + Date.now()
    });
    let sent = 0;
    subs.forEach(sub => {
      webpush.sendNotification(sub, payload)
        .then(() => sent++)
        .catch(() => {});
    });
    res.json({ success: true, subscribers: subs.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

// --- Push Notification Scheduler ---
function checkAndSendNotifications() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;

  try {
    const events = readJSON(TIMELINE_FILE);
    const subs = readJSON(SUBSCRIPTIONS_FILE);
    const sent = readJSON(SENT_NOTIFICATIONS_FILE);

    if (subs.length === 0) return;

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    const todayStr = now.toISOString().split('T')[0];

    const upcomingEvents = events.filter(e =>
      e.notify &&
      !e.completed &&
      (e.date === tomorrowStr || e.date === todayStr)
    );

    upcomingEvents.forEach(event => {
      const notifKey = `${event.id}_${event.date}`;
      if (sent.includes(notifKey)) return;

      const isToday = event.date === todayStr;
      const payload = JSON.stringify({
        title: `Life Vault - ${isToday ? 'Today' : 'Tomorrow'}`,
        body: `${event.title}${event.time ? ' at ' + event.time : ''}`,
        icon: '/manifest-icon-192.png',
        tag: event.id
      });

      const deadSubs = [];
      subs.forEach((sub, idx) => {
        webpush.sendNotification(sub, payload).catch(err => {
          if (err.statusCode === 404 || err.statusCode === 410) {
            deadSubs.push(idx);
          }
        });
      });

      // Clean dead subscriptions
      if (deadSubs.length > 0) {
        const liveSubs = subs.filter((_, idx) => !deadSubs.includes(idx));
        writeJSON(SUBSCRIPTIONS_FILE, liveSubs);
      }

      sent.push(notifKey);
      writeJSON(SENT_NOTIFICATIONS_FILE, sent);
    });
  } catch (err) {
    console.error('Notification check error:', err.message);
  }
}

// Check every 30 minutes
setInterval(checkAndSendNotifications, 30 * 60 * 1000);

// ==========================================
// START
// ==========================================

app.listen(PORT, () => {
  console.log(`Life Vault running on http://localhost:${PORT}`);
  // Run initial notification check after startup
  setTimeout(checkAndSendNotifications, 5000);
});
