const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const { JWT_SECRET, requireAdmin } = require('../middleware/auth');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'info@trayakshai.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const LEGACY_2FA_SECRET = 'TRAYAKSHAIADMIN2FASECRET2026';

function generateBase32Secret(byteLength = 20) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.randomBytes(byteLength);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let secret = '';
  for (let i = 0; i < bits.length; i += 5) {
    secret += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  return secret;
}

// Persistent Settings Helpers
async function getAdminSetting(key, defaultValue = null) {
  if (db.hasDb()) {
    try {
      const res = await db.query('SELECT value FROM admin_settings WHERE key = $1', [key]);
      if (res.rows.length > 0) return res.rows[0].value;
    } catch (err) {
      console.error(`Failed to read admin setting ${key}:`, err.message);
      throw err;
    }
  } else {
    if (db.inMemoryStore.adminSettings && db.inMemoryStore.adminSettings.has(key)) {
      return db.inMemoryStore.adminSettings.get(key);
    }
  }
  return defaultValue;
}

async function setAdminSetting(key, value) {
  if (db.hasDb()) {
    await db.query(
      `INSERT INTO admin_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, String(value)]
    );
  } else {
    if (db.inMemoryStore.adminSettings) {
      db.inMemoryStore.adminSettings.set(key, String(value));
    }
  }
}

async function recordAuditLog(event, userEmail, ipAddress) {
  try {
    if (db.hasDb()) {
      await db.query(
        'INSERT INTO audit_logs (event, user_email, ip_address) VALUES ($1, $2, $3)',
        [event, userEmail, ipAddress || null]
      );
    } else {
      db.inMemoryStore.auditLogs.unshift({
        event,
        user_email: userEmail,
        ip_address: ipAddress || null,
        created_at: new Date().toISOString()
      });
      db.inMemoryStore.auditLogs.length = Math.min(db.inMemoryStore.auditLogs.length, 100);
    }
    return true;
  } catch (err) {
    console.error('Audit log write failed:', err.message);
    return false;
  }
}

// RFC 6238 TOTP Engine
function verifyTOTP(token, secretBase32) {
  if (!token || !secretBase32) return false;
  let cleanToken = String(token).trim();
  let cleanSecret = String(secretBase32).replace(/[\s=]/g, '').toUpperCase();
  if (/^\d{6}$/.test(cleanSecret) && !/^\d{6}$/.test(cleanToken)) {
    const tmp = cleanToken;
    cleanToken = cleanSecret;
    cleanSecret = tmp;
  }
  const currentEpoch = Math.floor(Date.now() / 1000);
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (let i = 0; i < cleanSecret.length; i++) {
    const val = base32chars.indexOf(cleanSecret[i]);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const keyBytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    keyBytes.push(parseInt(bits.substr(i, 8), 2));
  }
  const key = Buffer.from(keyBytes);

  // Check window: -30s, 0, +30s to tolerate clock drift
  for (let offset = -1; offset <= 1; offset++) {
    const timeStep = Math.floor(currentEpoch / 30) + offset;
    const timeBuf = Buffer.alloc(8);
    timeBuf.writeBigInt64BE(BigInt(timeStep));
    const hmac = crypto.createHmac('sha1', key).update(timeBuf).digest();
    const off = hmac[hmac.length - 1] & 0xf;
    const code = (
      ((hmac[off] & 0x7f) << 24) |
      ((hmac[off + 1] & 0xff) << 16) |
      ((hmac[off + 2] & 0xff) << 8) |
      (hmac[off + 3] & 0xff)
    ) % 1000000;
    if (code.toString().padStart(6, '0') === cleanToken) return true;
  }
  return false;
}

function generateTOTP(secretBase32, timeOffset = 0) {
  if (!secretBase32) return null;
  const currentEpoch = Math.floor(Date.now() / 1000);
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  const cleanSecret = String(secretBase32).replace(/[\s=]/g, '').toUpperCase();
  for (let i = 0; i < cleanSecret.length; i++) {
    const val = base32chars.indexOf(cleanSecret[i]);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const keyBytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    keyBytes.push(parseInt(bits.substr(i, 8), 2));
  }
  const key = Buffer.from(keyBytes);
  const timeStep = Math.floor(currentEpoch / 30) + timeOffset;
  const timeBuf = Buffer.alloc(8);
  timeBuf.writeBigInt64BE(BigInt(timeStep));
  const hmac = crypto.createHmac('sha1', key).update(timeBuf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = (
    ((hmac[off] & 0x7f) << 24) |
    ((hmac[off + 1] & 0xff) << 16) |
    ((hmac[off + 2] & 0xff) << 8) |
    (hmac[off + 3] & 0xff)
  ) % 1000000;
  return code.toString().padStart(6, '0');
}

function generateCandidateCredentials(email) {
  const cleanEmail = email.trim().toLowerCase();
  const localPart = cleanEmail.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_').slice(0, 18) || 'user';
  const emailSuffix = crypto.createHash('sha256').update(cleanEmail).digest('hex').slice(0, 6);
  const username = `cand_${localPart}_${emailSuffix}`;

  // Generate Ed25519 keys in OpenSSH format so `ssh -i` can use the private key.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });

  const rawPub = publicKey.subarray(publicKey.length - 32);
  const typeBuf = Buffer.from('ssh-ed25519');
  const sshString = value => Buffer.concat([
    Buffer.from([value.length >>> 24, value.length >>> 16 & 255, value.length >>> 8 & 255, value.length & 255]),
    value
  ]);
  const sshPubBuf = Buffer.concat([sshString(typeBuf), sshString(rawPub)]);
  const sshPublicKey = `ssh-ed25519 ${sshPubBuf.toString('base64')} ${cleanEmail}`;
  const keyFingerprint = 'SHA256:' + crypto.createHash('sha256').update(sshPubBuf).digest('base64').replace(/=+$/, '');
  const privateData = Buffer.concat([privateKey.subarray(privateKey.length - 32), rawPub]);
  const check = crypto.randomBytes(4);
  const unpadded = Buffer.concat([
    check,
    check,
    sshString(typeBuf),
    sshString(rawPub),
    sshString(privateData),
    sshString(Buffer.from(cleanEmail))
  ]);
  const paddingLength = (8 - (unpadded.length % 8)) % 8;
  const padding = Buffer.from(Array.from({ length: paddingLength }, (_, index) => index + 1));
  const privateBlock = Buffer.concat([unpadded, padding]);
  const opensshKey = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString(Buffer.from('none')),
    sshString(Buffer.from('none')),
    sshString(Buffer.alloc(0)),
    Buffer.from([0, 0, 0, 1]),
    sshString(sshPubBuf),
    sshString(privateBlock)
  ]);
  const privateKeyPem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${opensshKey.toString('base64').match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----`;

  return {
    username,
    sshPublicKey,
    sshPrivateKey: privateKeyPem,
    keyFingerprint
  };
}

// Pre-hash admin password at startup for bcrypt comparison
let adminPasswordHash = null;

if (ADMIN_PASSWORD) {
  adminPasswordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
} else {
  console.warn('⚠️ ADMIN_PASSWORD env var is not set. Admin login will be disabled until configured.');
}

// 1. ADMIN STUDIO AUTHENTICATION
router.post('/login', async (req, res) => {
  try {
    const { email, password, twoFactorCode } = req.body;

    const savedHash = await getAdminSetting('admin_password_hash');
    const activeHash = savedHash || adminPasswordHash;

    if (!activeHash) {
      return res.status(503).json({ error: 'Admin authentication is not configured. Set ADMIN_PASSWORD environment variable on Render.' });
    }

    if (!email || !password) {
      return res.status(400).json({ error: 'Please enter both administrator email and password.' });
    }

    if (email.trim().toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
      return res.status(403).json({ error: 'Access Denied: This email is not authorized for Studio Administration.' });
    }

    const isMatch = await bcrypt.compare(password, activeHash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid administrator credentials.' });
    }

    // Check persistent 2FA status
    const is2faActive = (await getAdminSetting('admin_2fa_enabled')) === 'true';
    if (is2faActive) {
      if (!twoFactorCode) {
        return res.status(403).json({
          requires2FA: true,
          error: 'Two-Factor Authentication is active for info@trayakshai.com. Please enter your 6-digit authenticator code.'
        });
      }
      const twoFaSecret = await getAdminSetting('admin_2fa_secret');
      if (!twoFaSecret || twoFaSecret === LEGACY_2FA_SECRET) {
        return res.status(503).json({ error: 'Admin authenticator setup is incomplete. Disable and re-enable 2FA from an active admin session.' });
      }
      const isOtpValid = verifyTOTP(twoFactorCode, twoFaSecret);
      if (!isOtpValid) {
        return res.status(401).json({ error: 'Invalid 2FA verification code. Verification failed.' });
      }
    }

    // Sign high-privilege Admin Token
    const token = jwt.sign(
      {
        id: 'admin_master',
        email: ADMIN_EMAIL,
        name: 'TrayakshAI Infrastructure Operations',
        role: 'admin'
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Record audit event
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').toString().split(',')[0].trim();
    await recordAuditLog('Admin Studio Login', ADMIN_EMAIL, ip);

    res.json({
      message: 'Administrator session established',
      token,
      admin: {
        email: ADMIN_EMAIL,
        name: 'TrayakshAI Infrastructure Operations',
        role: 'Super Administrator'
      }
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Server error during admin authentication.' });
  }
});

router.get('/session', requireAdmin, (req, res) => {
  res.json({ success: true, email: req.user.email, role: req.user.role });
});

router.get('/cohort-settings', requireAdmin, async (req, res) => {
  try {
    if (db.hasDb()) {
      const result = await db.query(
        'SELECT cohort_deadline, max_seats, registrations_open FROM courses WHERE id = $1',
        ['ai-infrastructure-factory']
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Cohort configuration was not found.' });
      const settings = result.rows[0];
      return res.json({
        registrationOpen: settings.registrations_open,
        maxSeats: settings.max_seats,
        deadline: settings.cohort_deadline
      });
    }

    res.json({
      registrationOpen: (await getAdminSetting('cohort_registrations_open', 'true')) === 'true',
      maxSeats: Number(await getAdminSetting('cohort_max_seats', '25')) || 25,
      deadline: '2026-10-23T23:59:59+05:30'
    });
  } catch (err) {
    console.error('Load cohort settings error:', err);
    res.status(500).json({ error: 'Failed to load cohort settings.' });
  }
});

router.post('/cohort-settings', requireAdmin, async (req, res) => {
  try {
    const { registrationOpen, maxSeats } = req.body;
    const cleanSeats = Number(maxSeats);
    if (typeof registrationOpen !== 'boolean' || !Number.isInteger(cleanSeats) || cleanSeats < 1 || cleanSeats > 500) {
      return res.status(400).json({ error: 'Choose a registration state and a seat limit from 1 to 500.' });
    }

    if (db.hasDb()) {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['ai-infrastructure-factory']);
        const result = await client.query(
          `UPDATE courses SET registrations_open = $1, max_seats = $2
           WHERE id = $3 RETURNING registrations_open, max_seats, cohort_deadline`,
          [registrationOpen, cleanSeats, 'ai-infrastructure-factory']
        );
        if (!result.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Cohort configuration was not found.' });
        }
        await client.query('COMMIT');
      } catch (txError) {
        await client.query('ROLLBACK');
        throw txError;
      } finally {
        client.release();
      }
    } else {
      await setAdminSetting('cohort_registrations_open', registrationOpen ? 'true' : 'false');
      await setAdminSetting('cohort_max_seats', cleanSeats);
    }

    await recordAuditLog(
      `Cohort settings updated: registrations ${registrationOpen ? 'open' : 'closed'}, seat limit ${cleanSeats}`,
      ADMIN_EMAIL,
      req.ip || '127.0.0.1'
    );
    res.json({ success: true, registrationOpen, maxSeats: cleanSeats });
  } catch (err) {
    console.error('Save cohort settings error:', err);
    res.status(500).json({ error: 'Failed to save cohort settings.' });
  }
});

// 2. GET ENROLLED CANDIDATES ROSTER (FROM POSTGRESQL)
router.get('/candidates', requireAdmin, async (req, res) => {
  try {
    let candidates = [];

    if (db.hasDb()) {
      const result = await db.query(
        `SELECT 
            e.registration_number AS id,
            u.full_name AS name,
            u.email,
            COALESCE(u.company, 'Individual') AS company,
            COALESCE(u.role, 'Solution Architect') AS role,
            o.amount,
            e.status,
            e.cluster_ssh_granted,
            e.enrolled_at
         FROM enrollments e
         JOIN users u ON e.user_id = u.id
         LEFT JOIN LATERAL (
           SELECT SUM(paid_order.amount) AS amount
           FROM orders paid_order
           WHERE paid_order.user_id = e.user_id
             AND paid_order.course_id = e.course_id
             AND paid_order.status = 'paid'
         ) o ON TRUE
         ORDER BY e.enrolled_at DESC`
      );
      candidates = result.rows.map(r => ({
        id: r.id,
        name: r.name,
        email: r.email,
        company: r.company,
        role: r.role,
        amount: r.amount ? `₹${(r.amount / 100).toLocaleString('en-IN')}` : '—',
        status: r.status ? (r.status.charAt(0).toUpperCase() + r.status.slice(1)) : 'Confirmed',
        sshGranted: Boolean(r.cluster_ssh_granted),
        enrolledAt: r.enrolled_at ? new Date(r.enrolled_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Recent'
      }));
    } else {
      candidates = Array.from(db.inMemoryStore.enrollments.values())
        .filter(enrollment => enrollment.status === 'active')
        .map(enrollment => {
          const user = Array.from(db.inMemoryStore.users.values()).find(candidate =>
            candidate.id === enrollment.user_id || candidate.email === enrollment.user_email
          ) || {};
          const paidOrders = Array.from(db.inMemoryStore.orders.values()).filter(candidate =>
            candidate.user_id === enrollment.user_id && candidate.course_id === enrollment.course_id && candidate.status === 'paid'
          );
          const amountPaid = paidOrders.reduce((total, order) => total + (Number(order.amount) || 0), 0);
          return {
            id: enrollment.registration_number,
            name: user.full_name || user.name || 'Candidate',
            email: user.email || enrollment.user_email || '',
            company: user.company || 'Individual',
            role: user.role || 'Candidate',
            amount: paidOrders.length ? `₹${(amountPaid / 100).toLocaleString('en-IN')}` : null,
            status: enrollment.status,
            sshGranted: Boolean(enrollment.cluster_ssh_granted),
            enrolledAt: enrollment.enrolled_at || null
          };
        });
    }

    res.json({ candidates });
  } catch (err) {
    console.error('Fetch candidates error:', err);
    res.status(500).json({ error: 'Failed to retrieve candidates roster.' });
  }
});

function normalizeEmbedVideoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:') return null;

    // YouTube formats (youtu.be/ID or youtube.com/watch?v=ID or /embed/ID)
    if (host === 'youtu.be') {
      const videoId = parsed.pathname.replace(/^\/+/, '').split('/')[0];
      if (/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`;
    }
    if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
      if (parsed.pathname.startsWith('/embed/')) {
        const videoId = parsed.pathname.split('/')[2];
        if (/^[a-zA-Z0-9_-]{11}$/.test(videoId || '')) return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`;
      }
      const v = parsed.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return `https://www.youtube-nocookie.com/embed/${v}?autoplay=1`;
      const parts = parsed.pathname.split('/');
      if (parts[1] === 'shorts' || parts[1] === 'live') {
        const vid = parts[2];
        if (/^[a-zA-Z0-9_-]{11}$/.test(vid || '')) return `https://www.youtube-nocookie.com/embed/${vid}?autoplay=1`;
      }
    }

    // Vimeo formats (vimeo.com/ID or player.vimeo.com/video/ID)
    if (host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') {
      if (host === 'player.vimeo.com') {
        const playerId = parsed.pathname.match(/^\/video\/(\d+)\/?$/);
        if (playerId) return `https://player.vimeo.com/video/${playerId[1]}`;
        return null;
      }
      const vimeoId = parsed.pathname.replace(/^\/+/, '').split('/')[0];
      if (/^\d+$/.test(vimeoId)) {
        return `https://player.vimeo.com/video/${vimeoId}`;
      }
    }

    if (host === 'trayakshai.com' || host === 'course.trayakshai.com') {
      return trimmed;
    }
  } catch (e) {}
  return null;
}

// 3. CREATE / UPLOAD NEW COURSE MODULE (INTO POSTGRESQL)
router.post('/modules', requireAdmin, async (req, res) => {
  try {
    const { track, title, type, duration, videoUrl, attachment, attachment_content, desc } = req.body;

    if (typeof track !== 'string' || !track.trim() || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Track and Lesson Title are required.' });
    }
    if (typeof attachment_content === 'string' && Buffer.byteLength(attachment_content, 'utf8') > 500 * 1024) {
      return res.status(413).json({ error: 'Blueprint content must be no larger than 500 KB.' });
    }
    if (attachment_content != null && typeof attachment_content !== 'string') {
      return res.status(400).json({ error: 'Blueprint content must be plain text.' });
    }
    if (typeof videoUrl !== 'string' || !videoUrl.trim()) {
      return res.status(400).json({ error: 'A hosted HTTPS video URL is required.' });
    }

    const modId = `mod_${crypto.randomUUID()}`;
    const trackNumber = parseInt(track.match(/\d+/) ? track.match(/\d+/)[0] : '1', 10);

    const sanitizedVideoUrl = normalizeEmbedVideoUrl(videoUrl);
    if (!sanitizedVideoUrl) {
      return res.status(400).json({ error: 'Invalid video URL: use HTTPS YouTube, Vimeo, or TrayakshAI hosting.' });
    }

    const newModule = {
      id: modId,
      course_id: 'ai-infrastructure-factory',
      track_number: trackNumber,
      track_title: track,
      lesson_title: title.trim(),
      lesson_type: type || 'Video Lecture',
      duration: duration || '60 mins',
      video_url: sanitizedVideoUrl,
      attachment: attachment || `${title.replace(/\s+/g, '_')}_Blueprint.md`,
      attachment_content: attachment_content || null,
      description: desc || 'Comprehensive enterprise architecture guide and production code.',
      sort_order: 0
    };

    if (db.hasDb()) {
      const orderResult = await db.query(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM modules WHERE course_id = $1",
        [newModule.course_id]
      );
      newModule.sort_order = Number(orderResult.rows[0].next_order);
      await db.query(
        `INSERT INTO modules (id, course_id, track_number, track_title, lesson_title, lesson_type, duration, video_url, attachment, description, attachment_content, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          newModule.id,
          newModule.course_id,
          newModule.track_number,
          newModule.track_title,
          newModule.lesson_title,
          newModule.lesson_type,
          newModule.duration,
          newModule.video_url,
          newModule.attachment,
          newModule.description,
          newModule.attachment_content,
          newModule.sort_order
        ]
      );
    } else {
      newModule.sort_order = Math.max(0, ...Array.from(db.inMemoryStore.modules.values()).map(module => Number(module.sort_order) || 0)) + 1;
      db.inMemoryStore.modules.set(modId, newModule);
    }

    await recordAuditLog(`Course module published: ${newModule.lesson_title}`, req.user.email, req.ip);
    res.status(201).json({
      success: true,
      message: 'Module published successfully to live classroom',
      module: newModule
    });
  } catch (err) {
    console.error('Create module error:', err);
    res.status(500).json({ error: 'Failed to publish module.' });
  }
});

// 4. GET SYSTEM AUDIT LOGS
router.get('/audit-logs', requireAdmin, async (req, res) => {
  try {
    let logs = [];
    if (db.hasDb()) {
      const result = await db.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50');
      logs = result.rows.map(r => ({
        event: r.event,
        user: r.user_email,
        ip: r.ip_address,
        timestamp: new Date(r.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      }));
    } else {
      logs = db.inMemoryStore.auditLogs.slice(0, 50).map(r => ({
        event: r.event,
        user: r.user_email,
        ip: r.ip_address || '',
        timestamp: new Date(r.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      }));
    }
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve audit logs.' });
  }
});

router.post('/audit-logs', requireAdmin, async (req, res) => {
  try {
    const event = typeof req.body.event === 'string' ? req.body.event.trim() : '';
    if (!event || event.length > 150) {
      return res.status(400).json({ error: 'An audit event between 1 and 150 characters is required.' });
    }
    const recorded = await recordAuditLog(event, req.user.email, req.ip || '127.0.0.1');
    if (!recorded) return res.status(503).json({ error: 'Audit logging is unavailable.' });
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('Create audit log error:', err);
    res.status(500).json({ error: 'Failed to record the audit event.' });
  }
});

// 5. DELETE COURSE MODULE
router.delete('/modules/:id', requireAdmin, async (req, res) => {
  try {
    const moduleId = req.params.id;
    if (!moduleId) {
      return res.status(400).json({ error: 'Module ID is required.' });
    }

    if (db.hasDb()) {
      const result = await db.query('DELETE FROM modules WHERE id = $1 RETURNING id', [moduleId]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Module not found.' });
      }
    } else {
      if (!db.inMemoryStore.modules.has(moduleId)) {
        return res.status(404).json({ error: 'Module not found.' });
      }
      db.inMemoryStore.modules.delete(moduleId);
    }

    await recordAuditLog(`Course module deleted: ${moduleId}`, req.user.email, req.ip);
    res.json({ success: true, message: 'Module deleted successfully.' });
  } catch (err) {
    console.error('Delete module error:', err);
    res.status(500).json({ error: 'Failed to delete module.' });
  }
});

// 6. Provision a candidate through the configured cluster access service.
router.post('/send-ssh-keys', requireAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: 'Candidate email is required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const provisionerUrl = process.env.CLUSTER_PROVISIONING_URL;
    const provisionerToken = process.env.CLUSTER_PROVISIONING_TOKEN;
    const sshHost = process.env.CLUSTER_SSH_HOST;
    if (!provisionerUrl || !provisionerToken || !sshHost) {
      return res.status(503).json({ error: 'Cluster provisioning is not configured. No access was granted.' });
    }

    let enrollment = null;
    if (db.hasDb()) {
      const candidate = await db.query(
        `SELECT e.registration_number FROM enrollments e
         JOIN users u ON u.id = e.user_id
         WHERE u.email = $1 AND e.status = 'active'`,
        [cleanEmail]
      );
      enrollment = candidate.rows[0] || null;
    } else {
      for (const enr of db.inMemoryStore.enrollments.values()) {
        if ((enr.user_email || '').toLowerCase() === cleanEmail && enr.status === 'active') {
          enrollment = enr;
          break;
        }
      }
    }
    if (!enrollment) {
      return res.status(404).json({ error: 'No active enrollment exists for this candidate.' });
    }

    const creds = generateCandidateCredentials(cleanEmail);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 10000);
    let provisioned;
    try {
      const provisionResponse = await fetch(`${provisionerUrl.replace(/\/+$/, '')}/v1/candidates/provision`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provisionerToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: cleanEmail,
          username: creds.username,
          publicKey: creds.sshPublicKey,
          fingerprint: creds.keyFingerprint,
          registrationNumber: enrollment.registration_number
        }),
        signal: abortController.signal
      });
      provisioned = await provisionResponse.json().catch(() => ({}));
      if (!provisionResponse.ok || !provisioned.success) {
        return res.status(502).json({ error: 'Cluster access service rejected the provisioning request. No access was granted.' });
      }
    } finally {
      clearTimeout(timeout);
    }

    if (db.hasDb()) {
      const updated = await db.query(
        `UPDATE enrollments SET cluster_ssh_granted = TRUE
         WHERE status = 'active' AND user_id = (SELECT id FROM users WHERE email = $1)`,
        [cleanEmail]
      );
      if (updated.rowCount === 0) {
        return res.status(409).json({ error: 'Enrollment changed during provisioning. Review cluster access before retrying.' });
      }
    }
    await recordAuditLog(`Cluster SSH provisioned for ${cleanEmail} (${creds.keyFingerprint})`, ADMIN_EMAIL, req.ip || '127.0.0.1');
    if (!db.hasDb()) {
      for (const [_, enr] of db.inMemoryStore.enrollments) {
        if (enr.user_email === cleanEmail) {
          enr.cluster_ssh_granted = true;
        }
      }
    }

    const sshCommand = provisioned.sshCommand || `ssh -i trayaksh_id_ed25519 ${creds.username}@${sshHost}`;
    res.json({
      success: true,
      message: `Cluster access was provisioned for ${cleanEmail}.`,
      email: cleanEmail,
      fingerprint: creds.keyFingerprint,
      credentials: {
        publicKey: creds.sshPublicKey,
        privateKey: creds.sshPrivateKey,
        wireguardConfig: provisioned.wireguardConfig || '',
        sshCommand
      }
    });
  } catch (err) {
    console.error('Send SSH keys error:', err);
    res.status(500).json({ error: 'Failed to dispatch cluster SSH keys.' });
  }
});

// 7. CHANGE ADMIN MASTER PASSWORD (PERSISTENT IN DB)
router.post('/change-password', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Both current and new passwords are required.' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
    }

    const savedHash = await getAdminSetting('admin_password_hash');
    const activeHash = savedHash || adminPasswordHash;

    const isMatch = await bcrypt.compare(currentPassword, activeHash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Current master password does not match.' });
    }

    const newHash = bcrypt.hashSync(newPassword, 10);
    await setAdminSetting('admin_password_hash', newHash);
    adminPasswordHash = newHash;

    await recordAuditLog('Master Admin Password Updated', ADMIN_EMAIL, req.ip || '127.0.0.1');

    res.json({
      success: true,
      message: 'Master administrator password successfully updated and persisted.'
    });
  } catch (err) {
    console.error('Change admin password error:', err);
    res.status(500).json({ error: 'Failed to update administrator password.' });
  }
});

// 8. READ 2FA POLICY
router.get('/2fa-settings', requireAdmin, async (req, res) => {
  try {
    const twoFactorEnabled = (await getAdminSetting('admin_2fa_enabled')) === 'true';
    const secret = twoFactorEnabled ? await getAdminSetting('admin_2fa_secret') : null;
    res.json({
      twoFactorEnabled,
      secret: secret || undefined,
      otpauthUrl: secret
        ? `otpauth://totp/${encodeURIComponent(`TrayakshAI:${ADMIN_EMAIL}`)}?secret=${secret}&issuer=${encodeURIComponent('TrayakshAI')}&algorithm=SHA1&digits=6&period=30`
        : undefined
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load 2FA policy.' });
  }
});

// 9. TOGGLE 2FA POLICY (PERSISTENT IN DB)
router.post('/toggle-2fa', requireAdmin, async (req, res) => {
  try {
    const { enabled } = req.body;
    if (![true, false, 'true', 'false'].includes(enabled)) {
      return res.status(400).json({ error: 'A boolean enabled value is required.' });
    }
    const isEnabled = enabled === true || enabled === 'true';
    let currentSecret = await getAdminSetting('admin_2fa_secret');
    if (isEnabled && (!currentSecret || currentSecret === LEGACY_2FA_SECRET)) {
      currentSecret = generateBase32Secret();
      await setAdminSetting('admin_2fa_secret', currentSecret);
    }
    await setAdminSetting('admin_2fa_enabled', isEnabled ? 'true' : 'false');

    await recordAuditLog(`Admin 2FA Policy Changed: ${isEnabled ? 'Enabled' : 'Disabled'}`, ADMIN_EMAIL, req.ip || '127.0.0.1');

    res.json({
      success: true,
      twoFactorEnabled: isEnabled,
      secret: isEnabled ? currentSecret : undefined,
      otpauthUrl: isEnabled
        ? `otpauth://totp/${encodeURIComponent(`TrayakshAI:${ADMIN_EMAIL}`)}?secret=${currentSecret}&issuer=${encodeURIComponent('TrayakshAI')}&algorithm=SHA1&digits=6&period=30`
        : undefined,
      message: `Two-Factor Authentication is now ${isEnabled ? 'ENABLED' : 'DISABLED'} for ${ADMIN_EMAIL}.`
    });
  } catch (err) {
    console.error('Toggle 2FA error:', err);
    res.status(500).json({ error: 'Failed to toggle 2FA policy.' });
  }
});

// 10. GATEWAY SETTINGS MANAGEMENT (PERSISTENT RAZORPAY CONFIGURATION)
router.get('/gateway-settings', requireAdmin, async (req, res) => {
  try {
    const keyId = (await getAdminSetting('razorpay_key_id')) || process.env.RAZORPAY_KEY_ID || '';
    const hasSecret = Boolean((await getAdminSetting('razorpay_key_secret')) || process.env.RAZORPAY_KEY_SECRET);
    const hasWebhook = Boolean((await getAdminSetting('razorpay_webhook_secret')) || process.env.RAZORPAY_WEBHOOK_SECRET);
    res.json({
      keyId,
      hasSecret,
      hasWebhook
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load gateway settings.' });
  }
});

router.post('/gateway-settings', requireAdmin, async (req, res) => {
  try {
    const { keyId, secret, webhookSecret } = req.body;
    if (keyId != null && typeof keyId !== 'string') {
      return res.status(400).json({ error: 'Razorpay Key ID must be text.' });
    }
    if (secret != null && (typeof secret !== 'string' || secret.length > 1024)) {
      return res.status(400).json({ error: 'Razorpay Key Secret must be text up to 1024 characters.' });
    }
    if (webhookSecret != null && (typeof webhookSecret !== 'string' || webhookSecret.length > 1024)) {
      return res.status(400).json({ error: 'Razorpay webhook secret must be text up to 1024 characters.' });
    }
    const cleanKeyId = typeof keyId === 'string' ? keyId.trim() : '';
    if (cleanKeyId && !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(cleanKeyId)) {
      return res.status(400).json({ error: 'Enter a valid Razorpay test or live Key ID.' });
    }
    if (cleanKeyId) await setAdminSetting('razorpay_key_id', cleanKeyId);
    if (secret) await setAdminSetting('razorpay_key_secret', secret.trim());
    if (webhookSecret) await setAdminSetting('razorpay_webhook_secret', webhookSecret.trim());
    await recordAuditLog('Razorpay Gateway Settings Updated via Admin Studio', ADMIN_EMAIL, req.ip || '127.0.0.1');

    const savedKeyId = (await getAdminSetting('razorpay_key_id')) || process.env.RAZORPAY_KEY_ID || '';
    const hasSecret = Boolean((await getAdminSetting('razorpay_key_secret')) || process.env.RAZORPAY_KEY_SECRET);

    res.json({
      success: true,
      ready: Boolean(savedKeyId && hasSecret),
      message: savedKeyId && hasSecret
        ? 'Razorpay credentials were saved on the server.'
        : (savedKeyId
          ? 'The Key ID is saved, but a Key Secret is still required before payments can be accepted.'
          : 'Razorpay Key ID and Key Secret are required before payments can be accepted.'),
      keyId: savedKeyId
    });
  } catch (err) {
    console.error('Update gateway settings error:', err);
    res.status(500).json({ error: 'Failed to update gateway settings.' });
  }
});

router.getAdminSetting = getAdminSetting;
router.setAdminSetting = setAdminSetting;
router.verifyTOTP = verifyTOTP;
router.generateTOTP = generateTOTP;
router.normalizeEmbedVideoUrl = normalizeEmbedVideoUrl;
router.generateCandidateCredentials = generateCandidateCredentials;
module.exports = router;

