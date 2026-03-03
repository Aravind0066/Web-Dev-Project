const express = require('express');
const router = express.Router();
const db = require('../config/db');
const bcrypt = require('bcrypt');

function getDeviceType(userAgent) {
  const ua = (userAgent || '').toLowerCase();
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) return 'mobile';
  if (ua.includes('ipad') || ua.includes('tablet')) return 'tablet';
  return 'desktop';
}

async function upsertUserSession({ userId, sessionToken, req }) {
  if (!userId || !sessionToken) return;
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.ip || null;
  const ua = req.headers['user-agent'] || null;
  const device = getDeviceType(ua);
  const expires = req.session?.cookie?._expires ? new Date(req.session.cookie._expires) : new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.query(
    `INSERT INTO user_sessions (user_id, session_token, ip_address, user_agent, device_type, is_active, expires_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       ip_address = VALUES(ip_address),
       user_agent = VALUES(user_agent),
       device_type = VALUES(device_type),
       is_active = 1,
       expires_at = VALUES(expires_at),
       last_activity = CURRENT_TIMESTAMP`,
    [userId, sessionToken, ip, ua, device, expires]
  );
}

/**
 * Helper: validate VIT student email format
 * Example: firstname.lastname2024@vitstudent.ac.in
 * - must end with @vitstudent.ac.in
 * - must contain a join year in the form 20XX just before the @
 */
function isValidVitEmail(email) {
  if (!email) return false;
  const lower = email.trim().toLowerCase();
  if (!lower.endsWith('@vitstudent.ac.in')) return false;
  // Require join year before @ (20XX)
  const localPart = lower.split('@')[0];
  return /20\d{2}$/.test(localPart);
}

/**
 * POST /api/auth/register
 * Body: { name, email, password }
 * Rules:
 *  - Email must be a VIT student email (…20XX@vitstudent.ac.in)
 *  - Role is always "student" (only one admin is created manually)
 *  - On success: creates user, logs them in, returns user info
 */
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    if (!isValidVitEmail(cleanEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Use your VIT student email ending with 20XX@vitstudent.ac.in (e.g. firstname.lastname2024@vitstudent.ac.in).'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password should be at least 6 characters.'
      });
    }

    // Check if user already exists
    const [existing] = await db.query(
      'SELECT id FROM users WHERE email = ?',
      [cleanEmail]
    );
    if (existing && existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists.'
      });
    }

    // Hash password
    const hash = await bcrypt.hash(password, 10);

    // Always create as student; admin is managed separately
    const [result] = await db.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [name.trim(), cleanEmail, hash, 'student']
    );

    const user = {
      id: result.insertId,
      name: name.trim(),
      email: cleanEmail,
      role: 'student'
    };

    // Log the user in (create session)
    req.session.user = user;

    // Update last_login and create a session record (best-effort)
    try {
      await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
      await upsertUserSession({ userId: user.id, sessionToken: req.sessionID, req });
    } catch (e) {
      console.warn('Session tracking (register) failed:', e.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      user
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 * On success: sets session, returns { success: true, user: { id, name, email, role } }
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required.' });
    }

    const [rows] = await db.query(
      'SELECT id, name, email, password_hash, role FROM users WHERE email = ?',
      [email.trim().toLowerCase()]
    );

    if (!rows || rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const user = rows[0];
    const storedHash = user.password_hash || '';

    // Support both bcrypt hashes and plain text (for initial seed)
    let valid = false;
    if (storedHash.startsWith('$2')) {
      valid = await bcrypt.compare(password, storedHash);
    } else {
      valid = password === storedHash;
    }

    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    };

    // Update last_login + session tracking (best-effort)
    try {
      await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
      await upsertUserSession({ userId: user.id, sessionToken: req.sessionID, req });
    } catch (e) {
      console.warn('Session tracking (login) failed:', e.message);
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (req, res) => {
  const token = req.sessionID;
  // Best-effort: mark DB session inactive
  if (token) {
    setImmediate(async () => {
      try {
        await db.query('UPDATE user_sessions SET is_active = 0 WHERE session_token = ?', [token]);
      } catch (e) {
        console.warn('Session tracking (logout) failed:', e.message);
      }
    });
  }
  req.session.destroy(() => {});
  res.json({ success: true });
});

/**
 * GET /api/auth/me
 * Returns current user from session (for frontend to restore state).
 */
router.get('/me', (req, res) => {
  console.log('GET /api/auth/me - Session:', req.session);
  if (!req.session || !req.session.user) {
    return res.status(401).json({ success: false, user: null });
  }
  res.json({ success: true, user: req.session.user });
});

module.exports = router;
