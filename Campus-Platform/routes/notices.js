const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { requireAuth, requireAdmin } = require('../middlewares/auth');

async function getOrCreateCategoryId(categoryName, type) {
  if (!categoryName) return null;
  const name = categoryName.trim();
  if (!name) return null;

  const [existing] = await db.query('SELECT id FROM categories WHERE name = ? AND type = ?', [name, type]);
  if (existing && existing.length > 0) return existing[0].id;

  try {
    const [result] = await db.query('INSERT INTO categories (name, type, is_active) VALUES (?, ?, 1)', [name, type]);
    return result.insertId;
  } catch (e) {
    const [rows2] = await db.query('SELECT id FROM categories WHERE name = ? AND type = ?', [name, type]);
    return rows2 && rows2.length ? rows2[0].id : null;
  }
}

/**
 * GET /api/notices
 * Returns all notices (anyone can view, no auth required)
 * Ordered by created_at DESC (newest first)
 */
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT n.id, n.title, n.body, n.priority, n.target_audience, n.is_pinned, 
             n.view_count, n.expires_at, n.created_at,
             u.name AS created_by_name, u.email AS created_by_email,
             c.name AS category, c.color AS category_color, c.icon AS category_icon
      FROM notices n
      LEFT JOIN users u ON n.created_by = u.id
      LEFT JOIN categories c ON n.category_id = c.id
      WHERE (n.expires_at IS NULL OR n.expires_at > NOW())
      ORDER BY n.is_pinned DESC, n.created_at DESC
    `);
    
    res.json({ success: true, data: rows || [] });
  } catch (err) {
    console.error('Notices list error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

/**
 * POST /api/notices
 * Creates a new notice (admin only)
 * Body: { title, body, priority }
 */
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, body, priority, category, target_audience } = req.body || {};
    
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'Title and body required.' });
    }
    
    if (!['normal', 'important', 'emergency'].includes(priority)) {
      return res.status(400).json({ success: false, message: 'Priority must be normal, important, or emergency.' });
    }
    
    const userId = req.session.user.id;
    
    // Get category_id (auto-create if missing)
    const categoryId = await getOrCreateCategoryId(category, 'notice');
    
    const target = target_audience || 'all';
    
    const [result] = await db.query(
      `INSERT INTO notices (created_by, category_id, title, body, priority, target_audience) VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, categoryId, title.trim(), body.trim(), priority, target]
    );
    
    // Increment view count for creator
    await db.query('UPDATE notices SET view_count = view_count + 1 WHERE id = ?', [result.insertId]);
    
    console.log('Notice created successfully, ID:', result.insertId);
    
    // Send email notifications (async, don't wait for response)
    if (process.env.EMAIL_HOST) {
      // Trigger email notification in background
      setImmediate(async () => {
        try {
          const nodemailer = require('nodemailer');
          const db = require('../config/db');
          
          const emailTransporter = nodemailer.createTransport({
            host: process.env.EMAIL_HOST,
            port: parseInt(process.env.EMAIL_PORT || '587'),
            secure: process.env.EMAIL_SECURE === 'true',
            auth: {
              user: process.env.EMAIL_USER,
              pass: process.env.EMAIL_PASS
            }
          });
          
          const [users] = await db.query('SELECT email FROM users WHERE email IS NOT NULL');
          if (users && users.length > 0) {
            const emails = users.map(u => u.email).join(', ');
            const priorityLabel = priority === 'emergency' ? ' EMERGENCY' : 
                                  priority === 'important' ? ' IMPORTANT' : ' Notice';
            
            await emailTransporter.sendMail({
              from: `"Campus Platform" <${process.env.EMAIL_USER}>`,
              to: emails,
              subject: `${priorityLabel}: ${title}`,
              html: `<h2>${title}</h2><p>${body.replace(/\n/g, '<br>')}</p><p><a href="${process.env.APP_URL || 'http://localhost:3000'}/noticeboard.html">View on Noticeboard</a></p>`
            });
            
            console.log(`Email notification sent to ${users.length} users`);
          }
        } catch (err) {
          console.error('Email notification error:', err);
        }
      });
    }
    
    res.json({ success: true, message: 'Notice created.', id: result.insertId });
  } catch (err) {
    console.error('Notice create error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

/**
 * POST /api/notices/:id/view
 * Tracks a notice view for the logged-in user (students/admins).
 * Inserts into notice_views (unique per notice_id + user_id) and increments notices.view_count only once per user.
 */
router.post('/:id/view', requireAuth, async (req, res) => {
  try {
    const noticeId = parseInt(req.params.id, 10);
    if (isNaN(noticeId)) return res.status(400).json({ success: false, message: 'Invalid notice id.' });

    const userId = req.session.user.id;
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.ip || null;
    const ua = req.headers['user-agent'] || null;

    // Ensure notice exists and not expired
    const [notices] = await db.query('SELECT id FROM notices WHERE id = ? AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1', [noticeId]);
    if (!notices || notices.length === 0) return res.status(404).json({ success: false, message: 'Notice not found.' });

    const [result] = await db.query(
      'INSERT IGNORE INTO notice_views (notice_id, user_id, ip_address, user_agent) VALUES (?, ?, ?, ?)',
      [noticeId, userId, ip, ua]
    );

    // mysql2 returns affectedRows on OkPacket for INSERT
    const inserted = result?.affectedRows === 1;
    if (inserted) {
      await db.query('UPDATE notices SET view_count = view_count + 1 WHERE id = ?', [noticeId]);
    }

    res.json({ success: true, viewed: true, counted: inserted });
  } catch (err) {
    console.error('Notice view error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

/**
 * GET /api/notices/views/stats
 * Returns count of notices viewed by current user
 */
router.get('/views/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [rows] = await db.query('SELECT COUNT(*) as count FROM notice_views WHERE user_id = ?', [userId]);
    res.json({ success: true, data: { viewed: rows[0]?.count || 0 } });
  } catch (err) {
    console.error('Notice views stats error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

/**
 * DELETE /api/notices/:id
 * Deletes a notice (admin only)
 */
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid notice id.' });
    }
    
    const [result] = await db.query('DELETE FROM notices WHERE id = ?', [id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Notice not found.' });
    }
    
    res.json({ success: true, message: 'Notice deleted.' });
  } catch (err) {
    console.error('Notice delete error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

module.exports = router;
