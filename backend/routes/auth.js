const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const db = require('../db');
const { JWT_SECRET, requireAuth } = require('../middleware/auth');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

router.get('/google-config', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
  }
  res.json({ clientId: GOOGLE_CLIENT_ID });
});

// Verification Code Helpers for proving email ownership
async function createAndSendClaimCode(email) {
  const code = crypto.randomInt(100000, 1000000).toString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
  const normalizedEmail = email.toLowerCase();
  if (db.hasDb()) {
    await db.query(
      `INSERT INTO email_verifications (email, code, purpose, expires_at)
       VALUES ($1, $2, 'claim_account', $3)`,
      [normalizedEmail, code, expiresAt]
    );
  } else {
    db.inMemoryStore.emailVerifications.set(normalizedEmail, {
      code,
      expiresAt: expiresAt.getTime(),
      consumed: false
    });
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  const emailFrom = process.env.EMAIL_FROM;
  if (!resendApiKey || !emailFrom) {
    if (process.env.NODE_ENV !== 'production') return code;
    await removeClaimCode(normalizedEmail, code);
    const error = new Error('Email verification is not configured. Please contact support.');
    error.statusCode = 503;
    throw error;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: emailFrom,
        to: [normalizedEmail],
        subject: 'Your TrayakshAI account verification code',
        text: `Your TrayakshAI verification code is ${code}. It expires in 15 minutes. If you did not request this code, ignore this email.`
      })
    });
    if (!response.ok) {
      throw new Error(`Email provider returned status ${response.status}.`);
    }
  } catch (deliveryError) {
    await removeClaimCode(normalizedEmail, code);
    console.error('Claim code delivery failed:', deliveryError.message);
    const error = new Error('We could not send the verification email. Please try again later.');
    error.statusCode = 502;
    throw error;
  }
  return code;
}

async function removeClaimCode(email, code) {
  if (db.hasDb()) {
    await db.query(
      `DELETE FROM email_verifications
       WHERE email = $1 AND code = $2 AND purpose = 'claim_account' AND consumed = FALSE`,
      [email, code]
    );
  } else {
    const record = db.inMemoryStore.emailVerifications.get(email);
    if (record && record.code === code) db.inMemoryStore.emailVerifications.delete(email);
  }
}

async function verifyEmailClaimCode(email, code) {
  if (!code) return false;
  const cleanCode = String(code).trim();
  if (db.hasDb()) {
    const res = await db.query(
      `WITH candidate AS (
         SELECT id FROM email_verifications
         WHERE email = $1 AND code = $2 AND purpose = 'claim_account'
           AND consumed = FALSE AND expires_at > NOW()
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE email_verifications AS verification
       SET consumed = TRUE
       FROM candidate
       WHERE verification.id = candidate.id AND verification.consumed = FALSE
       RETURNING verification.id`,
      [email.toLowerCase(), cleanCode]
    );
    if (res.rows.length > 0) return true;
  } else {
    const record = db.inMemoryStore.emailVerifications.get(email.toLowerCase());
    if (record && record.code === cleanCode && !record.consumed && record.expiresAt > Date.now()) {
      record.consumed = true;
      return true;
    }
  }
  return false;
}

// 0. DISPATCH EMAIL VERIFICATION CODE
router.post('/send-verification-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    const normalizedEmail = email.trim().toLowerCase();
    const sentCode = await createAndSendClaimCode(normalizedEmail);
    res.json({
      success: true,
      message: `A 6-digit verification code has been dispatched to ${normalizedEmail}.`,
      codePreview: process.env.NODE_ENV !== 'production' ? sentCode : undefined
    });
  } catch (err) {
    console.error('Send verification code error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to send verification code.' });
  }
});

// 1. REGISTER CANDIDATE
router.post('/register', async (req, res) => {
  try {
    const { email, password, phone, role, company, gstin, verification_code } = req.body;
    const fullName = (req.body.full_name || req.body.name || '').trim();

    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'Full name, email, and password are required.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const hashedPassword = await bcrypt.hash(password, 10);

    let user = null;

    if (db.hasDb()) {
      // Check existing
      const existingRes = await db.query('SELECT id, password_hash, google_id, is_active FROM users WHERE email = $1', [normalizedEmail]);
      if (existingRes.rows.length > 0) {
        const existing = existingRes.rows[0];
        if (existing.is_active === false) {
          return res.status(401).json({ error: 'This account is inactive. Contact support for help.' });
        }
        if (existing.password_hash || existing.google_id) {
          return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
        }
        // Account exists from guest checkout without credentials — verify email ownership first!
        if (!verification_code) {
          const sentCode = await createAndSendClaimCode(normalizedEmail);
          return res.status(403).json({
            requiresVerification: true,
            error: 'This email is linked to a cohort enrollment from checkout. For your security, a 6-digit verification code was dispatched to your email to prove ownership.',
            message: 'Verification code sent.',
            codePreview: process.env.NODE_ENV !== 'production' ? sentCode : undefined
          });
        }

        const isCodeValid = await verifyEmailClaimCode(normalizedEmail, verification_code);
        if (!isCodeValid) {
          return res.status(401).json({
            requiresVerification: true,
            error: 'Invalid or expired verification code. Please check your email or click Resend Code.'
          });
        }

        // Verified ownership: claim account and set password
        const updateRes = await db.query(
          `UPDATE users 
           SET password_hash = $1, 
               full_name = COALESCE(NULLIF($2, ''), full_name), 
               phone = COALESCE($3, phone), 
               company = COALESCE($4, company), 
               gstin = COALESCE($5, gstin), 
               updated_at = NOW()
           WHERE id = $6
           RETURNING id, email, full_name, role, company, phone, created_at`,
          [hashedPassword, fullName, phone || null, company || null, gstin || null, existing.id]
        );
        user = updateRes.rows[0];
      } else {
        const insertRes = await db.query(
          `INSERT INTO users (email, password_hash, full_name, phone, role, company, gstin)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, email, full_name, role, company, phone, created_at`,
          [normalizedEmail, hashedPassword, fullName, phone || null, 'candidate', company || null, gstin || null]
        );
        user = insertRes.rows[0];
      }
    } else {
      // In-memory fallback
      const existing = db.inMemoryStore.users.get(normalizedEmail);
      if (existing) {
        if (existing.is_active === false) {
          return res.status(401).json({ error: 'This account is inactive. Contact support for help.' });
        }
        if (existing.password_hash || existing.google_id) {
          return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
        }
        if (!verification_code) {
          const sentCode = await createAndSendClaimCode(normalizedEmail);
          return res.status(403).json({
            requiresVerification: true,
            error: 'This email is linked to a cohort enrollment from checkout. For your security, a 6-digit verification code was dispatched to your email to prove ownership.',
            message: 'Verification code sent.',
            codePreview: process.env.NODE_ENV !== 'production' ? sentCode : undefined
          });
        }

        const isCodeValid = await verifyEmailClaimCode(normalizedEmail, verification_code);
        if (!isCodeValid) {
          return res.status(401).json({
            requiresVerification: true,
            error: 'Invalid or expired verification code. Please check your email or click Resend Code.'
          });
        }

        existing.password_hash = hashedPassword;
        if (fullName) existing.full_name = fullName;
        if (phone) existing.phone = phone;
        if (company) existing.company = company;
        if (gstin) existing.gstin = gstin;
        user = existing;
      } else {
        user = {
          id: 'usr_' + crypto.randomUUID(),
          email: normalizedEmail,
          full_name: fullName,
          role: 'candidate',
          company: company || null,
          phone: phone || null,
          password_hash: hashedPassword,
          created_at: new Date().toISOString()
        };
        db.inMemoryStore.users.set(normalizedEmail, user);
      }
    }

    // Check if user already has an active enrollment (from guest checkout)
    let enrollment = null;
    if (db.hasDb()) {
      const enrRes = await db.query(
        'SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2 AND status = $3',
        [user.id, 'ai-infrastructure-factory', 'active']
      );
      if (enrRes.rows.length > 0) enrollment = enrRes.rows[0];
    } else {
      for (const [_, enr] of db.inMemoryStore.enrollments) {
        const matchesUser = enr.user_id === user.id || enr.user_email === user.email;
        const matchesCourse = !enr.course_id || enr.course_id === 'ai-infrastructure-factory';
        if (matchesUser && matchesCourse && enr.status === 'active') enrollment = enr;
      }
    }

    // Sign JWT Token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.full_name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'Registration successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.full_name,
        role: user.role,
        company: user.company
      },
      enrollment: enrollment ? {
        regId: enrollment.registration_number,
        status: enrollment.status,
        plan: enrollment.plan_enrolled
      } : null
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Server error during registration.' });
  }
});

// 2. SIGN IN CANDIDATE
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Please enter both email and password.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    let user = null;
    let enrollment = null;

    if (db.hasDb()) {
      const userRes = await db.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
      if (userRes.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      user = userRes.rows[0];

      if (!user.password_hash) {
        if (user.google_id) {
          return res.status(401).json({ error: 'This account was registered with Google OAuth. Please click "Continue with Google".' });
        }
        return res.status(401).json({ error: 'This account was created via checkout without a password. Please register your account credentials on the registration page.' });
      }

      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      if (user.is_active === false) {
        return res.status(401).json({ error: 'This account is inactive. Contact support for help.' });
      }

      // Check enrollment
      const enrRes = await db.query(
        'SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2 AND status = $3',
        [user.id, 'ai-infrastructure-factory', 'active']
      );
      if (enrRes.rows.length > 0) enrollment = enrRes.rows[0];
    } else {
      user = db.inMemoryStore.users.get(normalizedEmail);
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      if (!user.password_hash) {
        return res.status(401).json({ error: 'This account was created with Google OAuth. Please use "Continue with Google".' });
      }

      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return res.status(401).json({ error: 'Invalid email or password.' });
      if (user.is_active === false) {
        return res.status(401).json({ error: 'This account is inactive. Contact support for help.' });
      }
      for (const [_, candidateEnrollment] of db.inMemoryStore.enrollments) {
        const matchesUser = candidateEnrollment.user_id === user.id || candidateEnrollment.user_email === user.email;
        const matchesCourse = !candidateEnrollment.course_id || candidateEnrollment.course_id === 'ai-infrastructure-factory';
        if (matchesUser && matchesCourse && candidateEnrollment.status === 'active') enrollment = candidateEnrollment;
      }
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.full_name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.full_name,
        role: user.role,
        company: user.company
      },
      enrollment: enrollment ? {
        regId: enrollment.registration_number,
        status: enrollment.status,
        plan: enrollment.plan_enrolled
      } : null
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during sign in.' });
  }
});

// 3. GOOGLE OAUTH CREDENTIAL / TOKEN EXCHANGE
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Google authentication credential is required.' });
    }

    let targetEmail = null;
    let targetName = null;
    let targetGoogleId = null;

    // Cryptographically verify Google Identity Services ID token
    if (googleClient && GOOGLE_CLIENT_ID) {
      try {
        const ticket = await googleClient.verifyIdToken({
          idToken: credential,
          audience: GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();
        if (!payload || !payload.email_verified) {
          return res.status(403).json({ error: 'Google account email is not verified by Google. Verified email required to sign in.' });
        }
        targetEmail = payload.email;
        targetName = payload.name || targetEmail.split('@')[0];
        targetGoogleId = payload.sub;
      } catch (verifyErr) {
        console.error('Google token verification failed:', verifyErr.message);
        return res.status(401).json({ error: 'Google authentication signature verification failed.' });
      }
    } else {
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ error: 'Google OAuth is not configured on this production server (GOOGLE_CLIENT_ID missing).' });
      }
      // Development / sandbox simulation only: must decode a valid JWT credential payload with email_verified
      try {
        const decoded = jwt.decode(credential);
        if (decoded && decoded.email && decoded.email_verified !== false) {
          targetEmail = decoded.email;
          targetName = decoded.name || targetEmail.split('@')[0];
          targetGoogleId = decoded.sub;
        } else {
          return res.status(400).json({ error: 'Invalid Google credential token or unverified email.' });
        }
      } catch (e) {
        return res.status(400).json({ error: 'Failed to parse Google credential token.' });
      }
    }

    if (!targetEmail) {
      return res.status(400).json({ error: 'Google OAuth token does not contain a verified email.' });
    }

    const normalizedEmail = targetEmail.trim().toLowerCase();
    let user = null;
    let enrollment = null;

    if (db.hasDb()) {
      const userRes = await db.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
      if (userRes.rows.length > 0) {
        user = userRes.rows[0];
        if (targetGoogleId && !user.google_id) {
          await db.query('UPDATE users SET google_id = $1, updated_at = NOW() WHERE id = $2', [targetGoogleId, user.id]);
        }
      } else {
        const insertRes = await db.query(
          `INSERT INTO users (email, full_name, google_id, role)
           VALUES ($1, $2, $3, $4)
           RETURNING id, email, full_name, role, created_at`,
          [normalizedEmail, targetName || 'Google Candidate', targetGoogleId || null, 'candidate']
        );
        user = insertRes.rows[0];
      }

      if (user.is_active === false) {
        return res.status(401).json({ error: 'This account is inactive. Contact support for help.' });
      }

      const enrRes = await db.query(
        'SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2 AND status = $3',
        [user.id, 'ai-infrastructure-factory', 'active']
      );
      if (enrRes.rows.length > 0) enrollment = enrRes.rows[0];
    } else {
      user = db.inMemoryStore.users.get(normalizedEmail) || {
        id: 'usr_g_' + crypto.randomUUID(),
        email: normalizedEmail,
        full_name: targetName || 'Google Candidate',
        role: 'candidate',
        google_id: targetGoogleId
      };
      db.inMemoryStore.users.set(normalizedEmail, user);
      for (const [_, candidateEnrollment] of db.inMemoryStore.enrollments) {
        const matchesUser = candidateEnrollment.user_id === user.id || candidateEnrollment.user_email === user.email;
        const matchesCourse = !candidateEnrollment.course_id || candidateEnrollment.course_id === 'ai-infrastructure-factory';
        if (matchesUser && matchesCourse && candidateEnrollment.status === 'active') enrollment = candidateEnrollment;
      }
    }

    if (user.is_active === false) {
      return res.status(401).json({ error: 'This account is inactive. Contact support for help.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.full_name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Google authentication verified',
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.full_name,
        role: user.role
      },
      enrollment: enrollment ? {
        regId: enrollment.registration_number,
        status: enrollment.status,
        plan: enrollment.plan_enrolled,
        enrolledAt: enrollment.enrolled_at,
        clusterSshGranted: Boolean(enrollment.cluster_ssh_granted)
      } : null
    });
  } catch (err) {
    console.error('Google Auth error:', err);
    res.status(500).json({ error: 'Failed to verify Google authentication.' });
  }
});

// 4. GET CURRENT CANDIDATE PROFILE & ENROLLMENT STATUS
router.get('/me', requireAuth, async (req, res) => {
  try {
    let enrollment = null;
    let user = req.user;

    if (db.hasDb()) {
      const uRes = await db.query('SELECT id, email, full_name, role, company, phone, is_active FROM users WHERE id = $1', [req.user.id]);
      if (!uRes.rows.length || uRes.rows[0].is_active === false) {
        return res.status(401).json({ error: 'This account is inactive or no longer exists.' });
      }
      user = uRes.rows[0];

      const enrRes = await db.query(
        'SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2 AND status = $3',
        [req.user.id, 'ai-infrastructure-factory', 'active']
      );
      if (enrRes.rows.length > 0) enrollment = enrRes.rows[0];
    } else {
      const storedUser = Array.from(db.inMemoryStore.users.values()).find(candidate => candidate.id === req.user.id || candidate.email === req.user.email);
      if (!storedUser || storedUser.is_active === false) {
        return res.status(401).json({ error: 'This account is inactive or no longer exists.' });
      }
      user = storedUser;
      for (const [_, enr] of db.inMemoryStore.enrollments) {
        const matchesUser = enr.user_id === req.user.id || enr.user_email === req.user.email;
        const matchesCourse = !enr.course_id || enr.course_id === 'ai-infrastructure-factory';
        if (matchesUser && matchesCourse && enr.status === 'active') enrollment = enr;
      }
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.full_name || user.name,
        role: user.role,
        company: user.company
      },
      enrollment: enrollment ? {
        regId: enrollment.registration_number,
        plan: enrollment.plan_enrolled,
        status: enrollment.status,
        enrolledAt: enrollment.enrolled_at,
        clusterSshGranted: Boolean(enrollment.cluster_ssh_granted)
      } : null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve profile.' });
  }
});

router.createAndSendClaimCode = createAndSendClaimCode;
router.verifyEmailClaimCode = verifyEmailClaimCode;
module.exports = router;
