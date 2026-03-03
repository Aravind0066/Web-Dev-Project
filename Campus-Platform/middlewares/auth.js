/**
 * Require a logged-in user. Use on routes that need authentication.
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ success: false, message: 'Please log in.' });
  }
  next();
}

/**
 * Require admin role. Use after requireAuth on admin-only routes.
 */
function requireAdmin(req, res, next) {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin only.' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
