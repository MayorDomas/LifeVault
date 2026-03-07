require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;
const BUILD_VERSION = Date.now().toString();

// --- Config ---
const IDEA_CATEGORIES = ['general', 'project', 'work', 'personal', 'shopping'];
const FILE_CATEGORIES = ['documents', 'images', 'code', '3d-models', 'other'];
const TIMELINE_CATEGORIES = ['personal', 'work', 'health', 'finance', 'milestone', 'other'];
const DATA_DIR = path.join(__dirname, 'data');
const IDEAS_FILE = path.join(DATA_DIR, 'ideas.json');
const IDEAS_HISTORY_FILE = path.join(DATA_DIR, 'ideas-history.json');
const TIMELINE_FILE = path.join(DATA_DIR, 'timeline.json');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
const SENT_NOTIFICATIONS_FILE = path.join(DATA_DIR, 'sent-notifications.json');
const COURSES_FILE = path.join(DATA_DIR, 'courses.json');
const DEADLINES_FILE = path.join(DATA_DIR, 'deadlines.json');
const HABITS_FILE = path.join(DATA_DIR, 'habits.json');
const HABIT_CHECKINS_FILE = path.join(DATA_DIR, 'habit-checkins.json');
const GOALS_FILE = path.join(DATA_DIR, 'goals.json');
const LISTS_FILE = path.join(DATA_DIR, 'lists.json');
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

// --- Middleware ---
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- No-cache headers for all static files ---
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// --- Serve sw.js dynamically with unique version ---
app.get('/sw.js', (req, res) => {
  const swPath = path.join(__dirname, 'public', 'sw.js');
  let content = fs.readFileSync(swPath, 'utf8');
  content = `// BUILD_VERSION: ${BUILD_VERSION}\n` + content;
  res.set('Content-Type', 'application/javascript');
  res.send(content);
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  maxAge: 0
}));

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

// --- Auth Middleware (no password required) ---
function requireAuth(req, res, next) {
  return next();
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
// HEALTH CHECK
// ==========================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: BUILD_VERSION, timestamp: new Date().toISOString() });
});

// ==========================================
// AUTH ROUTES (no auth required)
// ==========================================

app.get('/api/auth', (req, res) => {
  res.json({ authenticated: true });
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
// TODOS ROUTES
// ==========================================

app.post('/api/todos', requireAuth, (req, res) => {
  try {
    const { title, description, date, time } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }
    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }
    const todo = {
      id: uuidv4(),
      title: title.trim(),
      description: (description || '').trim(),
      date,
      time: time || '',
      completed: false,
      notify: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const todos = readJSON(TODOS_FILE);
    todos.unshift(todo);
    writeJSON(TODOS_FILE, todos);
    res.json({ success: true, todo });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save todo' });
  }
});

app.get('/api/todos', requireAuth, (req, res) => {
  try {
    let todos = readJSON(TODOS_FILE);
    const { year, month } = req.query;
    if (year) {
      todos = todos.filter(t => t.date && t.date.startsWith(year));
    }
    if (year && month) {
      const prefix = `${year}-${month.padStart(2, '0')}`;
      todos = todos.filter(t => t.date && t.date.startsWith(prefix));
    }
    todos.sort((a, b) => {
      if (a.date === b.date) {
        return (a.time || '').localeCompare(b.time || '');
      }
      return a.date.localeCompare(b.date);
    });
    res.json({ todos });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load todos' });
  }
});

app.put('/api/todos/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, date, time, completed } = req.body;
    const todos = readJSON(TODOS_FILE);
    const idx = todos.findIndex(t => t.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Todo not found' });
    if (title !== undefined) todos[idx].title = title.trim();
    if (description !== undefined) todos[idx].description = description.trim();
    if (date !== undefined) todos[idx].date = date;
    if (time !== undefined) todos[idx].time = time;
    if (completed !== undefined) todos[idx].completed = !!completed;
    todos[idx].updatedAt = new Date().toISOString();
    writeJSON(TODOS_FILE, todos);
    res.json({ success: true, todo: todos[idx] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update todo' });
  }
});

app.delete('/api/todos/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    let todos = readJSON(TODOS_FILE);
    const before = todos.length;
    todos = todos.filter(t => t.id !== id);
    if (todos.length === before) return res.status(404).json({ error: 'Todo not found' });
    writeJSON(TODOS_FILE, todos);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete todo' });
  }
});

// ==========================================
// COURSES ROUTES (Studies)
// ==========================================

app.get('/api/courses', requireAuth, (req, res) => {
  try {
    const courses = readJSON(COURSES_FILE);
    res.json({ courses });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load courses' });
  }
});

app.post('/api/courses', requireAuth, (req, res) => {
  try {
    const { name, day, startTime, endTime, room, color } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!day || day < 1 || day > 7) return res.status(400).json({ error: 'Day must be 1-7' });
    const course = {
      id: uuidv4(),
      name: name.trim(),
      day: parseInt(day, 10),
      startTime: startTime || '08:00',
      endTime: endTime || '09:30',
      room: (room || '').trim(),
      color: color || '#8b5cf6',
      createdAt: new Date().toISOString()
    };
    const courses = readJSON(COURSES_FILE);
    courses.push(course);
    writeJSON(COURSES_FILE, courses);
    res.json({ success: true, course });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save course' });
  }
});

app.put('/api/courses/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { name, day, startTime, endTime, room, color } = req.body;
    const courses = readJSON(COURSES_FILE);
    const idx = courses.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Course not found' });
    if (name !== undefined) courses[idx].name = name.trim();
    if (day !== undefined) courses[idx].day = parseInt(day, 10);
    if (startTime !== undefined) courses[idx].startTime = startTime;
    if (endTime !== undefined) courses[idx].endTime = endTime;
    if (room !== undefined) courses[idx].room = room.trim();
    if (color !== undefined) courses[idx].color = color;
    writeJSON(COURSES_FILE, courses);
    res.json({ success: true, course: courses[idx] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update course' });
  }
});

app.delete('/api/courses/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    let courses = readJSON(COURSES_FILE);
    const before = courses.length;
    courses = courses.filter(c => c.id !== id);
    if (courses.length === before) return res.status(404).json({ error: 'Course not found' });
    writeJSON(COURSES_FILE, courses);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete course' });
  }
});

// ==========================================
// DEADLINES ROUTES (Studies)
// ==========================================

app.get('/api/deadlines', requireAuth, (req, res) => {
  try {
    const deadlines = readJSON(DEADLINES_FILE);
    deadlines.sort((a, b) => a.date.localeCompare(b.date));
    res.json({ deadlines });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load deadlines' });
  }
});

app.post('/api/deadlines', requireAuth, (req, res) => {
  try {
    const { title, courseId, courseName, date, time, type, description, notify } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
    if (!date) return res.status(400).json({ error: 'Date is required' });
    const deadline = {
      id: uuidv4(),
      title: title.trim(),
      courseId: courseId || '',
      courseName: (courseName || '').trim(),
      date,
      time: time || '',
      type: ['exam', 'assignment', 'project', 'other'].includes(type) ? type : 'other',
      description: (description || '').trim(),
      notify: notify !== false,
      completed: false,
      createdAt: new Date().toISOString()
    };
    const deadlines = readJSON(DEADLINES_FILE);
    deadlines.push(deadline);
    writeJSON(DEADLINES_FILE, deadlines);
    res.json({ success: true, deadline });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save deadline' });
  }
});

app.put('/api/deadlines/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { title, courseId, courseName, date, time, type, description, notify, completed } = req.body;
    const deadlines = readJSON(DEADLINES_FILE);
    const idx = deadlines.findIndex(d => d.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Deadline not found' });
    if (title !== undefined) deadlines[idx].title = title.trim();
    if (courseId !== undefined) deadlines[idx].courseId = courseId;
    if (courseName !== undefined) deadlines[idx].courseName = courseName.trim();
    if (date !== undefined) deadlines[idx].date = date;
    if (time !== undefined) deadlines[idx].time = time;
    if (type !== undefined) deadlines[idx].type = type;
    if (description !== undefined) deadlines[idx].description = description.trim();
    if (notify !== undefined) deadlines[idx].notify = !!notify;
    if (completed !== undefined) deadlines[idx].completed = !!completed;
    writeJSON(DEADLINES_FILE, deadlines);
    res.json({ success: true, deadline: deadlines[idx] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update deadline' });
  }
});

app.delete('/api/deadlines/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    let deadlines = readJSON(DEADLINES_FILE);
    const before = deadlines.length;
    deadlines = deadlines.filter(d => d.id !== id);
    if (deadlines.length === before) return res.status(404).json({ error: 'Deadline not found' });
    writeJSON(DEADLINES_FILE, deadlines);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete deadline' });
  }
});

// ==========================================
// HABITS ROUTES
// ==========================================

app.get('/api/habits', requireAuth, (req, res) => {
  try {
    const habits = readJSON(HABITS_FILE);
    res.json({ habits });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load habits' });
  }
});

app.post('/api/habits', requireAuth, (req, res) => {
  try {
    const { name, frequency, color } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const habit = {
      id: uuidv4(),
      name: name.trim(),
      frequency: frequency === 'weekly' ? 'weekly' : 'daily',
      color: color || '#8b5cf6',
      createdAt: new Date().toISOString()
    };
    const habits = readJSON(HABITS_FILE);
    habits.push(habit);
    writeJSON(HABITS_FILE, habits);
    res.json({ success: true, habit });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save habit' });
  }
});

app.put('/api/habits/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { name, frequency, color } = req.body;
    const habits = readJSON(HABITS_FILE);
    const idx = habits.findIndex(h => h.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Habit not found' });
    if (name !== undefined) habits[idx].name = name.trim();
    if (frequency !== undefined) habits[idx].frequency = frequency;
    if (color !== undefined) habits[idx].color = color;
    writeJSON(HABITS_FILE, habits);
    res.json({ success: true, habit: habits[idx] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update habit' });
  }
});

app.delete('/api/habits/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    let habits = readJSON(HABITS_FILE);
    const before = habits.length;
    habits = habits.filter(h => h.id !== id);
    if (habits.length === before) return res.status(404).json({ error: 'Habit not found' });
    writeJSON(HABITS_FILE, habits);
    // Also remove checkins for this habit
    let checkins = readJSON(HABIT_CHECKINS_FILE);
    checkins = checkins.filter(c => c.habitId !== id);
    writeJSON(HABIT_CHECKINS_FILE, checkins);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete habit' });
  }
});

// ==========================================
// HABIT CHECK-INS ROUTES
// ==========================================

app.get('/api/habits/checkins', requireAuth, (req, res) => {
  try {
    let checkins = readJSON(HABIT_CHECKINS_FILE);
    const { habitId, from, to } = req.query;
    if (habitId) checkins = checkins.filter(c => c.habitId === habitId);
    if (from) checkins = checkins.filter(c => c.date >= from);
    if (to) checkins = checkins.filter(c => c.date <= to);
    res.json({ checkins });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load checkins' });
  }
});

app.post('/api/habits/checkins', requireAuth, (req, res) => {
  try {
    const { habitId, date } = req.body;
    if (!habitId || !date) return res.status(400).json({ error: 'habitId and date required' });
    const checkins = readJSON(HABIT_CHECKINS_FILE);
    const exists = checkins.find(c => c.habitId === habitId && c.date === date);
    if (exists) return res.json({ success: true, checkin: exists });
    const checkin = { id: uuidv4(), habitId, date };
    checkins.push(checkin);
    writeJSON(HABIT_CHECKINS_FILE, checkins);
    res.json({ success: true, checkin });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save checkin' });
  }
});

app.delete('/api/habits/checkins', requireAuth, (req, res) => {
  try {
    const { habitId, date } = req.body;
    if (!habitId || !date) return res.status(400).json({ error: 'habitId and date required' });
    let checkins = readJSON(HABIT_CHECKINS_FILE);
    checkins = checkins.filter(c => !(c.habitId === habitId && c.date === date));
    writeJSON(HABIT_CHECKINS_FILE, checkins);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete checkin' });
  }
});

// ==========================================
// GOALS ROUTES
// ==========================================

app.get('/api/goals', requireAuth, (req, res) => {
  try {
    const goals = readJSON(GOALS_FILE);
    res.json({ goals });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load goals' });
  }
});

app.post('/api/goals', requireAuth, (req, res) => {
  try {
    const { title, description, targetDate, progress, status } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
    const goal = {
      id: uuidv4(),
      title: title.trim(),
      description: (description || '').trim(),
      targetDate: targetDate || '',
      progress: Math.min(100, Math.max(0, parseInt(progress, 10) || 0)),
      status: ['active', 'completed', 'paused'].includes(status) ? status : 'active',
      createdAt: new Date().toISOString()
    };
    const goals = readJSON(GOALS_FILE);
    goals.push(goal);
    writeJSON(GOALS_FILE, goals);
    res.json({ success: true, goal });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save goal' });
  }
});

app.put('/api/goals/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, targetDate, progress, status } = req.body;
    const goals = readJSON(GOALS_FILE);
    const idx = goals.findIndex(g => g.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Goal not found' });
    if (title !== undefined) goals[idx].title = title.trim();
    if (description !== undefined) goals[idx].description = description.trim();
    if (targetDate !== undefined) goals[idx].targetDate = targetDate;
    if (progress !== undefined) goals[idx].progress = Math.min(100, Math.max(0, parseInt(progress, 10) || 0));
    if (status !== undefined) goals[idx].status = status;
    writeJSON(GOALS_FILE, goals);
    res.json({ success: true, goal: goals[idx] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update goal' });
  }
});

app.delete('/api/goals/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    let goals = readJSON(GOALS_FILE);
    const before = goals.length;
    goals = goals.filter(g => g.id !== id);
    if (goals.length === before) return res.status(404).json({ error: 'Goal not found' });
    writeJSON(GOALS_FILE, goals);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete goal' });
  }
});

// ==========================================
// LISTS (To Buy / To Do) ROUTES
// ==========================================

app.get('/api/lists', requireAuth, (req, res) => {
  try {
    const items = readJSON(LISTS_FILE);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load lists' });
  }
});

app.post('/api/lists', requireAuth, (req, res) => {
  try {
    const { text, type } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Text is required' });
    const item = {
      id: uuidv4(),
      text: text.trim(),
      type: type === 'buy' ? 'buy' : 'do',
      completed: false,
      createdAt: new Date().toISOString()
    };
    const items = readJSON(LISTS_FILE);
    items.unshift(item);
    writeJSON(LISTS_FILE, items);
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save item' });
  }
});

app.put('/api/lists/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { text, type, completed } = req.body;
    const items = readJSON(LISTS_FILE);
    const idx = items.findIndex(i => i.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Item not found' });
    if (text !== undefined) items[idx].text = text.trim();
    if (type !== undefined) items[idx].type = type;
    if (completed !== undefined) items[idx].completed = !!completed;
    writeJSON(LISTS_FILE, items);
    res.json({ success: true, item: items[idx] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update item' });
  }
});

app.delete('/api/lists/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    let items = readJSON(LISTS_FILE);
    const before = items.length;
    items = items.filter(i => i.id !== id);
    if (items.length === before) return res.status(404).json({ error: 'Item not found' });
    writeJSON(LISTS_FILE, items);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete item' });
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

    // Also check todos
    const todos = readJSON(TODOS_FILE);
    const upcomingTodos = todos.filter(t =>
      t.notify !== false &&
      !t.completed &&
      (t.date === tomorrowStr || t.date === todayStr)
    );

    // Also check deadlines
    const deadlines = readJSON(DEADLINES_FILE);
    const upcomingDeadlines = deadlines.filter(d =>
      d.notify &&
      !d.completed &&
      (d.date === tomorrowStr || d.date === todayStr)
    );

    const allItems = [
      ...upcomingEvents.map(e => ({ ...e, _type: 'Event' })),
      ...upcomingTodos.map(t => ({ ...t, _type: 'To-Do' })),
      ...upcomingDeadlines.map(d => ({ ...d, _type: 'Deadline' }))
    ];

    allItems.forEach(item => {
      const notifKey = `${item.id}_${item.date}`;
      if (sent.includes(notifKey)) return;

      const isToday = item.date === todayStr;
      const payload = JSON.stringify({
        title: `Life Vault - ${item._type} ${isToday ? 'Today' : 'Tomorrow'}`,
        body: `${item.title}${item.time ? ' at ' + item.time : ''}`,
        icon: '/manifest-icon-192.png',
        tag: item.id
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
