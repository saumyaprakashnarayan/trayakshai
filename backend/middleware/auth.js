const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');

const NODE_ENV = process.env.NODE_ENV || 'development';

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // Never fall back to a static/known secret string. Always generate an ephemeral, secure 256-bit key.
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('⚠️ WARNING: JWT_SECRET environment variable is not configured.');
  console.warn('⚠️ An ephemeral cryptographically secure 256-bit session key has been generated.');
  console.warn('⚠️ To persist candidate sessions across server redeploys, set JWT_SECRET in your server environment.');
}

// Extract token from Authorization header or cookie
function extractToken(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }
  if (req.headers['x-auth-token']) {
    return req.headers['x-auth-token'];
  }
  return null;
}

// Require valid authenticated user
function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Authentication token is required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired session token.' });
  }
}

// Optional auth: attaches req.user if token is present
function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      // ignore
    }
  }
  next();
}

// Require administrator role (Verifies token signature AND verifies against user store)
async function requireAdmin(req, res, next) {
  requireAuth(req, res, async () => {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: Administrator privileges required.' });
    }

    try {
      if (db.hasDb()) {
        const adminCheck = await db.query(
          `SELECT id, role, is_active FROM users WHERE (id = $1 OR email = $2) AND role = 'admin' AND is_active = TRUE`,
          [req.user.id, req.user.email]
        );
        if (!adminCheck.rows.length) {
          return res.status(403).json({ error: 'Forbidden: Administrator privileges could not be confirmed.' });
        }
      } else {
        const storedAdmin = Array.from(db.inMemoryStore.users ? db.inMemoryStore.users.values() : []).find(
          u => (u.id === req.user.id || u.email === req.user.email) && u.role === 'admin'
        );
        // Allow built-in root admin credentials
        if (!storedAdmin && req.user.email !== 'info@trayakshai.com') {
          return res.status(403).json({ error: 'Forbidden: Administrator privileges could not be confirmed.' });
        }
      }
      next();
    } catch (err) {
      console.error('Admin verification check error:', err.message);
      return res.status(500).json({ error: 'Failed to verify administrator privileges.' });
    }
  });
}

// Require active paid course enrollment
async function requireEnrollment(req, res, next) {
  requireAuth(req, res, async () => {
    const userId = req.user.id;
    const userEmail = req.user.email;
    const courseId = req.params.courseId || 'ai-infrastructure-factory';

    // Super admin always has access
    if (req.user.role === 'admin') {
      return next();
    }

    try {
      if (db.hasDb()) {
        const result = await db.query(
          `SELECT e.* FROM enrollments e
           JOIN users u ON e.user_id = u.id
           WHERE e.user_id = $1 AND e.course_id = $2 AND e.status = $3 AND u.is_active = TRUE`,
          [userId, courseId, 'active']
        );
        if (result.rows.length > 0) {
          req.enrollment = result.rows[0];
          return next();
        }
      } else {
        // In-memory check for dev
        const storedUser = Array.from(db.inMemoryStore.users.values()).find(
          user => user.id === userId || String(user.email || '').toLowerCase() === String(userEmail || '').toLowerCase()
        );
        if (!storedUser || storedUser.is_active === false) {
          return res.status(401).json({ error: 'This account is inactive or no longer exists.' });
        }
        for (const [id, enr] of db.inMemoryStore.enrollments) {
          const matchUser = (enr.user_id === userId || enr.user_email === userEmail);
          const matchCourse = (!enr.course_id || enr.course_id === courseId);
          if (matchUser && matchCourse && enr.status === 'active') {
            req.enrollment = enr;
            return next();
          }
        }
      }

      return res.status(403).json({
        error: 'Forbidden: You must be registered in this cohort to access private materials and terminals.',
        requiredPlan: 'registration',
        amount: 9999
      });
    } catch (err) {
      console.error('Error verifying enrollment:', err.message);
      return res.status(500).json({ error: 'Failed to verify course access.' });
    }
  });
}

module.exports = {
  JWT_SECRET,
  requireAuth,
  optionalAuth,
  requireAdmin,
  requireEnrollment
};
