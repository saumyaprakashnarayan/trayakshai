const jwt = require('jsonwebtoken');
const db = require('../db');

const NODE_ENV = process.env.NODE_ENV || 'development';

if (!process.env.JWT_SECRET && NODE_ENV === 'production') {
  console.error('❌ FATAL: JWT_SECRET environment variable is required in production. Exiting.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || 'DEV_ONLY_trayaksh_jwt_secret_DO_NOT_USE_IN_PRODUCTION_2026';

if (!process.env.JWT_SECRET) {
  console.warn('⚠️ JWT_SECRET not set — using insecure development-only key. Set JWT_SECRET before deploying.');
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

// Require administrator role
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user && req.user.role === 'admin') {
      next();
    } else {
      res.status(403).json({ error: 'Forbidden: Administrator privileges required.' });
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
