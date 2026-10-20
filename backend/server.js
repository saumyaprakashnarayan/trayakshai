const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
require('dotenv').config();

const db = require('./db');
const authRoutes = require('./routes/auth');
const paymentRoutes = require('./routes/payment');
const classroomRoutes = require('./routes/classroom');
const adminRoutes = require('./routes/admin');

const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 10000;

// Trust reverse proxy (Render & Vercel)
app.set('trust proxy', 1);

// Security Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://checkout.razorpay.com", "https://accounts.google.com"],
      frameSrc: ["'self'", "https://api.razorpay.com", "https://www.youtube-nocookie.com", "https://www.youtube.com", "https://player.vimeo.com", "https://accounts.google.com"],
      connectSrc: ["'self'", "https://api.razorpay.com", "https://accounts.google.com", "https://course.trayakshai.com", "https://trayakshai.com", "https://*.onrender.com", "https://*.vercel.app"],
      imgSrc: ["'self'", "data:", "https:"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      objectSrc: ["'none'"]
    }
  },
  hsts: process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false
}));

// HTTPS Redirect in Production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// Throttling / Rate Limiting (Brute-Force & Credential Stuffing Prevention)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 25, // 25 attempts per IP per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts from this IP address. Please wait 15 minutes.' }
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300, // 300 requests per IP per 15 mins
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', apiLimiter);

// CORS Configuration (Permits main domain, course subdomain, and local testing)
const allowedOrigins = [
  'https://course.trayakshai.com',
  'https://trayakshai.com',
  'https://www.trayakshai.com',
  'http://localhost:3000',
  'http://localhost:5000',
  'http://localhost:5173',
  'http://localhost:8000',
  'http://localhost:8080',
  'http://localhost:10000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5000',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:8000',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:10000'
];

if (process.env.ADDITIONAL_CORS_ORIGIN) {
  allowedOrigins.push(process.env.ADDITIONAL_CORS_ORIGIN);
}

app.use(cors({
  origin: function (origin, callback) {
    // Allow server-to-server (no origin) and explicitly allowlisted origins
    const isTrayakshPreview = origin && (
      (origin.endsWith('.vercel.app') && origin.includes('trayaksh')) ||
      (origin.endsWith('.onrender.com') && origin.includes('trayaksh'))
    );

    if (!origin || allowedOrigins.includes(origin) || isTrayakshPreview) {
      callback(null, true);
    } else {
      console.warn(`⚠️ CORS: Blocked request from unauthorized origin: ${origin}`);
      callback(new Error(`Origin ${origin} not allowed by CORS policy`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token', 'X-Razorpay-Signature']
}));

// Body Parsers with Raw Body Preservation for Webhook HMAC Signature Verification
app.use(express.json({ 
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health Check with Active Database Ping & Schema Readiness
app.get('/healthz', async (req, res) => {
  let dbStatus = db.hasDb() ? 'connected' : 'in-memory-sandbox';
  if (db.hasDb()) {
    try {
      await db.query('SELECT 1 AS alive');
      if (!db.isReady()) {
        return res.status(503).json({
          status: 'initializing',
          timestamp: new Date().toISOString(),
          service: 'TrayakshAI Course Backend (Render)',
          database: 'schema-not-ready',
          error: db.getInitError() || 'PostgreSQL schema initialization in progress'
        });
      }
      dbStatus = 'connected';
    } catch (dbErr) {
      console.error('Health check DB ping failed:', dbErr.message);
      return res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        service: 'TrayakshAI Course Backend (Render)',
        database: 'unreachable',
        error: dbErr.message
      });
    }
  }
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'TrayakshAI Course Backend (Render)',
    database: dbStatus,
    subdomain: 'course.trayakshai.com'
  });
});

// API Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/classroom', classroomRoutes);
// Rate limit only admin login, not all admin routes (GET candidates/audit-logs)
app.use('/api/admin/login', authLimiter);
app.use('/api/admin', adminRoutes);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({
    error: 'Internal server error occurred.',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start Server & Initialize Database
async function startServer() {
  if (db.hasDb()) {
    console.log('Connecting to PostgreSQL database and verifying schema...');
    const ok = await db.initDb();
    if (!ok && process.env.NODE_ENV === 'production') {
      console.error('❌ FATAL: Database initialization failed in production. Exiting.');
      process.exit(1);
    }
  } else {
    console.warn('⚠️ NOTICE: DATABASE_URL is not configured on Render. Operating with in-memory sandbox storage.');
    console.warn('⚠️ To enable persistent PostgreSQL storage, configure DATABASE_URL in Render Dashboard.');
  }

  const server = app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 TrayakshAI Course Backend running on port ${PORT}`);
    console.log(`🌐 Target Subdomain: https://course.trayakshai.com`);
    console.log(`🏥 Health Check: http://localhost:${PORT}/healthz`);
    console.log(`=======================================================`);
  });
  return server;
}

if (require.main === module) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = app;
