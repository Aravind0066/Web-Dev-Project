require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const app = express();
const db = require('./config/db');

const authRoutes = require('./routes/auth');
const resourcesRoutes = require('./routes/resources');
const postsRoutes = require('./routes/posts');
const noticesRoutes = require('./routes/notices');
const adminRoutes = require('./routes/admin');
const notificationsRoutes = require('./routes/notifications');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

// Touch user_sessions.last_activity (throttled; best-effort)
app.use((req, res, next) => {
  try {
    if (req.session?.user?.id && req.sessionID) {
      const now = Date.now();
      const last = req.session._lastTouchedAt || 0;
      // only update once per 60s per session to avoid DB spam
      if (now - last > 60 * 1000) {
        req.session._lastTouchedAt = now;
        setImmediate(async () => {
          try {
            await db.query(
              'UPDATE user_sessions SET last_activity = CURRENT_TIMESTAMP WHERE session_token = ? AND is_active = 1',
              [req.sessionID]
            );
          } catch (e) {
            // ignore
          }
        });
      }
    }
  } catch (e) {
    // ignore
  }
  next();
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/resources', resourcesRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/notices', noticesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationsRoutes);

// Serve frontend (so login and API are same-origin and session works)
app.use(express.static(path.join(__dirname, 'public')));

// Fallback: backend health check if someone hits /api
app.get('/api', (req, res) => {
  res.json({ message: 'Campus Platform API', status: 'ok' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
