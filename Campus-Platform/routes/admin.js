const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { requireAuth, requireAdmin } = require('../middlewares/auth');

/**
 * GET /api/admin/stats
 * Returns overall system statistics (admin only)
 */
router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Total users
    const [userCount] = await db.query('SELECT COUNT(*) as count FROM users');
    const [adminCount] = await db.query("SELECT COUNT(*) as count FROM users WHERE role = 'admin'");
    const [studentCount] = await db.query("SELECT COUNT(*) as count FROM users WHERE role = 'student'");
    
    // Total posts
    const [postCount] = await db.query('SELECT COUNT(*) as count FROM posts');
    const [updateCount] = await db.query("SELECT COUNT(*) as count FROM posts WHERE type = 'update'");
    const [queryCount] = await db.query("SELECT COUNT(*) as count FROM posts WHERE type = 'query'");
    
    // Total resources
    const [resourceCount] = await db.query('SELECT COUNT(*) as count FROM resources');
    
    // Total notices
    const [noticeCount] = await db.query('SELECT COUNT(*) as count FROM notices');
    
    // Recent activity (last 7 days)
    const [recentPosts] = await db.query(`
      SELECT COUNT(*) as count FROM posts 
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    `);
    
    const [recentUsers] = await db.query(`
      SELECT COUNT(*) as count FROM users 
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    `);
    
    res.json({
      success: true,
      data: {
        users: {
          total: userCount[0]?.count || 0,
          admins: adminCount[0]?.count || 0,
          students: studentCount[0]?.count || 0
        },
        posts: {
          total: postCount[0]?.count || 0,
          updates: updateCount[0]?.count || 0,
          queries: queryCount[0]?.count || 0
        },
        resources: resourceCount[0]?.count || 0,
        notices: noticeCount[0]?.count || 0,
        recent: {
          posts: recentPosts[0]?.count || 0,
          users: recentUsers[0]?.count || 0
        }
      }
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

/**
 * GET /api/admin/users
 * Returns list of all users (admin only)
 */
router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT u.id, u.name, u.email, u.role, u.created_at,
             (SELECT COUNT(*) FROM posts WHERE user_id = u.id) as post_count
      FROM users u
      ORDER BY u.created_at DESC
    `);
    
    res.json({ success: true, data: rows || [] });
  } catch (err) {
    console.error('Admin users list error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

/**
 * PUT /api/admin/users/:id/role
 * Update user role (admin only)
 */
router.put('/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { role } = req.body || {};
    
    if (isNaN(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id.' });
    }
    
    if (!['student', 'admin'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Role must be student or admin.' });
    }
    
    // Prevent demoting yourself
    if (userId === req.session.user.id && role !== 'admin') {
      return res.status(400).json({ success: false, message: 'Cannot demote yourself.' });
    }

    // Enforce: only ONE admin account in the system
    if (role === 'admin') {
      const [admins] = await db.query("SELECT COUNT(*) as count FROM users WHERE role = 'admin'");
      const adminCount = admins[0]?.count || 0;
      const [targetRows] = await db.query('SELECT role FROM users WHERE id = ? LIMIT 1', [userId]);
      const targetRole = targetRows[0]?.role;

      const alreadyAdmin = targetRole === 'admin';
      if (!alreadyAdmin && adminCount >= 1) {
        return res.status(400).json({
          success: false,
          message: 'Only one admin is allowed. Demote the existing admin first (or keep a single admin for review).'
        });
      }
    }
    
    await db.query('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
    
    res.json({ success: true, message: 'User role updated.' });
  } catch (err) {
    console.error('Admin update role error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

/**
 * DELETE /api/admin/users/:id
 * Delete user (admin only)
 */
router.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    
    if (isNaN(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id.' });
    }
    
    // Prevent deleting yourself
    if (userId === req.session.user.id) {
      return res.status(400).json({ success: false, message: 'Cannot delete yourself.' });
    }

    // Prevent deleting the only admin account
    const [target] = await db.query('SELECT role FROM users WHERE id = ? LIMIT 1', [userId]);
    if (target && target.length && target[0].role === 'admin') {
      const [admins] = await db.query("SELECT COUNT(*) as count FROM users WHERE role = 'admin'");
      const adminCount = admins[0]?.count || 0;
      if (adminCount <= 1) {
        return res.status(400).json({ success: false, message: 'Cannot delete the only admin account.' });
      }
    }
    
    await db.query('DELETE FROM users WHERE id = ?', [userId]);
    
    res.json({ success: true, message: 'User deleted.' });
  } catch (err) {
    console.error('Admin delete user error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

module.exports = router;
