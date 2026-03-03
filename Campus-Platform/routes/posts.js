const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { requireAuth } = require('../middlewares/auth');

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
    // If another request inserted it concurrently, re-select
    const [rows2] = await db.query('SELECT id FROM categories WHERE name = ? AND type = ?', [name, type]);
    return rows2 && rows2.length ? rows2[0].id : null;
  }
}

/**
 * GET /api/posts
 * Query: type (update|query), search, category
 * Returns list of posts (for community page). Excludes expired updates when possible.
 */
router.get('/', async (req, res) => {
  try {
    let sql = `
      SELECT p.id, p.user_id, p.type, p.title, p.body, p.priority, p.expires_at, 
             p.status, p.view_count, p.created_at,
             u.name AS author_name, u.email AS author_email,
             c.name AS category, c.color AS category_color, c.icon AS category_icon,
             (SELECT COUNT(*) FROM post_replies WHERE post_id = p.id) AS reply_count
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (req.query.type) {
      sql += ' AND p.type = ?';
      params.push(req.query.type);
    }
    if (req.query.category) {
      sql += ' AND c.name = ?';
      params.push(req.query.category);
    }
    if (req.query.search) {
      sql += ' AND (p.title LIKE ? OR p.body LIKE ?)';
      const term = '%' + req.query.search.trim() + '%';
      params.push(term, term);
    }

    // Exclude expired updates (only for updates with expires_at, queries don't expire)
    if (req.query.type === 'update') {
      sql += ' AND (p.expires_at IS NULL OR p.expires_at > NOW())';
    }
    
    sql += ' ORDER BY p.created_at DESC';

    const [rows] = await db.query(sql, params);
    console.log(`GET /api/posts - Returning ${rows?.length || 0} posts`);
    res.json({ success: true, data: rows || [] });
  } catch (err) {
    console.error('Posts list error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

/**
 * POST /api/posts
 * Body: { type, title, body, category?, priority?, expires_at? }
 * Requires login. user_id taken from session.
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { type, title, body, category, priority, expires_at } = req.body || {};
    
    console.log('POST /api/posts - Received:', { type, title: title?.substring(0, 50), body: body?.substring(0, 50), category, priority, expires_at });
    console.log('Session user:', req.session.user);
    
    if (!type || !title || !body) {
      return res.status(400).json({ success: false, message: 'Type, title and body required.' });
    }
    if (!['update', 'query'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Type must be update or query.' });
    }

    const userId = req.session.user.id;
    const pri = (priority && ['normal', 'important', 'urgent'].includes(priority)) ? priority : 'normal';
    
    // Get category_id (auto-create if missing)
    const categoryId = await getOrCreateCategoryId(category, 'post');
    
    // Handle expires_at: convert to MySQL datetime format or null
    let exp = null;
    if (expires_at) {
      if (typeof expires_at === 'string' && expires_at.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)) {
        exp = expires_at;
      } else {
        const date = new Date(expires_at);
        if (!isNaN(date.getTime())) {
          exp = date.toISOString().slice(0, 19).replace('T', ' ');
        }
      }
    }

    const [result] = await db.query(
      `INSERT INTO posts (user_id, category_id, type, title, body, priority, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, categoryId, type, title.trim(), body.trim(), pri, exp]
    );

    console.log('Post created successfully, ID:', result.insertId);
    res.json({ success: true, message: 'Post created.', id: result.insertId });
  } catch (err) {
    console.error('Post create error:', err);
    console.error('Error details:', err.message, err.sql);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

/**
 * GET /api/posts/stats
 * Returns user-specific post counts (requires auth)
 */
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    console.log('GET /api/posts/stats - User ID:', userId);
    
    const [updateCount] = await db.query(
      'SELECT COUNT(*) as count FROM posts WHERE user_id = ? AND type = ?',
      [userId, 'update']
    );
    
    const [queryCount] = await db.query(
      'SELECT COUNT(*) as count FROM posts WHERE user_id = ? AND type = ?',
      [userId, 'query']
    );
    
    const updates = updateCount[0]?.count || 0;
    const queries = queryCount[0]?.count || 0;
    const total = updates + queries;
    
    console.log('Stats result:', { updates, queries, total });
    
    res.json({
      success: true,
      data: {
        updates: updates,
        queries: queries,
        total: total
      }
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

/**
 * GET /api/posts/:id
 * Returns a single post with author + category + reply_count
 */
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid post id.' });

    const [rows] = await db.query(
      `
      SELECT p.id, p.user_id, p.type, p.title, p.body, p.priority, p.expires_at,
             p.status, p.view_count, p.created_at,
             u.name AS author_name, u.email AS author_email,
             c.name AS category, c.color AS category_color, c.icon AS category_icon,
             (SELECT COUNT(*) FROM post_replies WHERE post_id = p.id) AS reply_count
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!rows || rows.length === 0) return res.status(404).json({ success: false, message: 'Post not found.' });

    // Increment view_count (best-effort)
    setImmediate(async () => {
      try {
        await db.query('UPDATE posts SET view_count = view_count + 1 WHERE id = ?', [id]);
      } catch (e) {
        // ignore
      }
    });

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('Post get error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

/**
 * GET /api/posts/:id/replies
 * Returns replies for a post
 */
router.get('/:id/replies', async (req, res) => {
  try {
    const postId = parseInt(req.params.id, 10);
    if (isNaN(postId)) return res.status(400).json({ success: false, message: 'Invalid post id.' });

    const [rows] = await db.query(
      `
      SELECT r.id, r.post_id, r.user_id, r.reply_text, r.is_accepted, r.is_helpful, r.created_at,
             u.name AS author_name, u.email AS author_email
      FROM post_replies r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.post_id = ?
      ORDER BY r.is_accepted DESC, r.created_at ASC
      `,
      [postId]
    );

    res.json({ success: true, data: rows || [] });
  } catch (err) {
    console.error('Replies list error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

/**
 * POST /api/posts/:id/replies
 * Body: { reply_text }
 * Requires login
 */
router.post('/:id/replies', requireAuth, async (req, res) => {
  try {
    const postId = parseInt(req.params.id, 10);
    const { reply_text } = req.body || {};
    if (isNaN(postId)) return res.status(400).json({ success: false, message: 'Invalid post id.' });
    if (!reply_text || !reply_text.trim()) return res.status(400).json({ success: false, message: 'Reply text required.' });

    // Ensure post exists
    const [posts] = await db.query('SELECT id FROM posts WHERE id = ? LIMIT 1', [postId]);
    if (!posts || posts.length === 0) return res.status(404).json({ success: false, message: 'Post not found.' });

    const userId = req.session.user.id;
    const [result] = await db.query(
      'INSERT INTO post_replies (post_id, user_id, reply_text) VALUES (?, ?, ?)',
      [postId, userId, reply_text.trim()]
    );

    res.json({ success: true, message: 'Reply added.', id: result.insertId });
  } catch (err) {
    console.error('Reply create error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

/**
 * PUT /api/posts/:postId/replies/:replyId/accept
 * Mark a reply as accepted (post author or admin)
 */
router.put('/:postId/replies/:replyId/accept', requireAuth, async (req, res) => {
  try {
    const postId = parseInt(req.params.postId, 10);
    const replyId = parseInt(req.params.replyId, 10);
    if (isNaN(postId) || isNaN(replyId)) return res.status(400).json({ success: false, message: 'Invalid id.' });

    const [posts] = await db.query('SELECT id, user_id FROM posts WHERE id = ? LIMIT 1', [postId]);
    if (!posts || posts.length === 0) return res.status(404).json({ success: false, message: 'Post not found.' });

    const post = posts[0];
    const isOwner = post.user_id === req.session.user.id;
    const isAdmin = req.session.user.role === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ success: false, message: 'Not allowed.' });

    const [replies] = await db.query('SELECT id FROM post_replies WHERE id = ? AND post_id = ? LIMIT 1', [replyId, postId]);
    if (!replies || replies.length === 0) return res.status(404).json({ success: false, message: 'Reply not found.' });

    // Only one accepted reply per post
    await db.query('UPDATE post_replies SET is_accepted = 0 WHERE post_id = ?', [postId]);
    await db.query('UPDATE post_replies SET is_accepted = 1 WHERE id = ? AND post_id = ?', [replyId, postId]);

    res.json({ success: true, message: 'Reply accepted.' });
  } catch (err) {
    console.error('Accept reply error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

module.exports = router;
