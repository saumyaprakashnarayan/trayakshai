const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Razorpay = require('razorpay');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { optionalAuth, requireAuth, JWT_SECRET } = require('../middleware/auth');

const adminRoutes = require('./admin');

const RZP_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

// Dynamic Gateway Credential Resolver (merges process.env with persistent admin studio settings)
async function getActiveRazorpayConfig() {
  const getAdminSetting = adminRoutes.getAdminSetting;
  let dynamicKey = null;
  let dynamicSecret = null;
  let dynamicWebhook = null;
  if (typeof getAdminSetting === 'function') {
    dynamicKey = await getAdminSetting('razorpay_key_id');
    dynamicSecret = await getAdminSetting('razorpay_key_secret');
    dynamicWebhook = await getAdminSetting('razorpay_webhook_secret');
  }
  const keyId = dynamicKey || process.env.RAZORPAY_KEY_ID || null;
  const keySecret = dynamicSecret || process.env.RAZORPAY_KEY_SECRET;
  const webhookSecret = dynamicWebhook || process.env.RAZORPAY_WEBHOOK_SECRET;

  let instance = null;
  if (keyId && keySecret) {
    instance = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }
  return { keyId, keySecret, webhookSecret, instance };
}

// Constant-time signature comparison to eliminate HMAC timing attacks
function safeCompareSignatures(sigA, sigB) {
  if (!sigA || !sigB || typeof sigA !== 'string' || typeof sigB !== 'string') return false;
  const bufA = Buffer.from(sigA);
  const bufB = Buffer.from(sigB);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function generateRegistrationNumber() {
  return `TR-AI-2026-${crypto.randomInt(100000, 1000000)}`;
}

async function generateUniqueRegistrationNumber(client) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['registration_number_generation']);
  for (let attempt = 0; attempt < 20; attempt++) {
    const registrationNumber = generateRegistrationNumber();
    const existing = await client.query(
      'SELECT 1 FROM enrollments WHERE registration_number = $1',
      [registrationNumber]
    );
    if (!existing.rows.length) return registrationNumber;
  }
  throw new Error('Could not allocate a unique registration number.');
}

function generateUniqueMemoryRegistrationNumber() {
  let registrationNumber;
  do {
    registrationNumber = generateRegistrationNumber();
  } while (Array.from(db.inMemoryStore.enrollments.values()).some(enrollment => enrollment.registration_number === registrationNumber));
  return registrationNumber;
}

async function createGatewayOrder(instance, plan, planKey, candidateEmail, company) {
  if (!instance) {
    if (process.env.NODE_ENV === 'production') {
      const error = new Error('Razorpay credentials are not configured on the production server.');
      error.statusCode = 503;
      throw error;
    }
    return `order_sim_${Date.now().toString().slice(-8)}`;
  }

  const rzpOrder = await instance.orders.create({
    amount: plan.amountPaise,
    currency: 'INR',
    receipt: `rcpt_${Date.now().toString().slice(-8)}`,
    expire_by: Math.floor(Date.now() / 1000) + 30 * 60,
    notes: {
      plan_type: planKey,
      candidate_email: candidateEmail,
      company: company || 'Not Provided',
      course: 'AI Infrastructure & AI Factory Training'
    }
  });
  return rzpOrder.id;
}

// Fixed server-side prices (Never trusted from client)
const PRICING = {
  registration: {
    amountPaise: 999900,
    amountRupees: 9999,
    name: 'Seat Registration Fee',
    description: 'TrayakshAI Registration Fee (Seat locked before 23 Oct deadline)'
  },
  course_fee: {
    amountPaise: 4999900,
    amountRupees: 49999,
    name: 'Course Fee',
    description: 'TrayakshAI 8-Track Complete Live Cohort & Bare-Metal Lab Access'
  }
};

// 1. CREATE RAZORPAY SERVER ORDER
router.post('/create-order', optionalAuth, async (req, res) => {
  try {
    const planType = req.body.plan_type || req.body.planKey;
    const { name, email, phone, company, gstin } = req.body;
    if (!['registration', 'course_fee'].includes(planType)) {
      return res.status(400).json({ error: 'A valid payment plan is required.' });
    }
    const planKey = planType;
    const plan = PRICING[planKey];

    let candidateEmail = (req.user && req.user.email) || email;
    let candidateName = (req.user && req.user.name) || name;

    if (req.user) {
      let authenticatedCandidate = null;
      if (db.hasDb()) {
        const userResult = await db.query(
          'SELECT id, email, full_name, is_active FROM users WHERE id = $1',
          [req.user.id]
        );
        authenticatedCandidate = userResult.rows[0] || null;
      } else {
        authenticatedCandidate = Array.from(db.inMemoryStore.users.values()).find(user => user.id === req.user.id) || null;
      }
      if (!authenticatedCandidate || authenticatedCandidate.is_active === false) {
        return res.status(401).json({ error: 'Your account is inactive or no longer exists. Sign in again before checkout.' });
      }
      candidateEmail = authenticatedCandidate.email;
      candidateName = authenticatedCandidate.full_name || authenticatedCandidate.name || candidateName;
    }

    if (!candidateEmail) {
      return res.status(400).json({ error: 'Candidate email is required to initiate order.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(candidateEmail).trim())) {
      return res.status(400).json({ error: 'A valid candidate email is required to initiate order.' });
    }

    // Check the deadline before creating a payment order. Capacity is reserved
    // atomically when the server persists the order below.
    const courseId = 'ai-infrastructure-factory';
    if (db.hasDb()) {
      const cRes = await db.query('SELECT cohort_deadline, max_seats, registrations_open FROM courses WHERE id = $1', [courseId]);
      if (cRes.rows.length > 0) {
        const course = cRes.rows[0];
        const now = new Date();
        const deadline = new Date(course.cohort_deadline);
        if (now > deadline) {
          return res.status(403).json({
            error: `Cohort registration deadline (${deadline.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST) has passed. Registrations for this batch are closed.`
          });
        }

      }
    } else {
      const deadline = new Date('2026-10-23T23:59:59+05:30');
      if (new Date() > deadline) {
        return res.status(403).json({ error: 'Cohort registration deadline has passed. Registrations are closed.' });
      }
    }

    const { keyId, instance: activeRzpInstance } = await getActiveRazorpayConfig();
    let rzpOrderId = null;

    // Save order record to DB
    let userId = req.user ? req.user.id : null;

    if (db.hasDb()) {
      if (!userId) {
        // Find candidate by email
        const uRes = await db.query('SELECT id, password_hash, google_id, is_active FROM users WHERE email = $1', [candidateEmail.toLowerCase()]);
        if (uRes.rows.length > 0) {
          const existingUser = uRes.rows[0];
          if (existingUser.is_active === false) {
            return res.status(401).json({ error: 'This account is inactive. Contact support before starting checkout.' });
          }
          // High Issue 1: Account Takeover Prevention
          // If the account already has credentials (password or google account), do NOT allow guest order creation with that email
          if (existingUser.password_hash || existingUser.google_id) {
            return res.status(409).json({
              error: 'An account with this email already exists. Please log in first to secure your registration.',
              requiresLogin: true
            });
          }
          userId = existingUser.id;
        } else {
          const newU = await db.query(
            `INSERT INTO users (email, full_name, phone, company, gstin, role)
             VALUES ($1, $2, $3, $4, $5, 'candidate')
             ON CONFLICT (email) DO NOTHING RETURNING id`,
            [candidateEmail.toLowerCase(), candidateName || candidateEmail.split('@')[0], phone || null, company || null, gstin || null]
          );
          if (newU.rows.length) {
            userId = newU.rows[0].id;
          } else {
            const racedUser = await db.query(
              'SELECT id, password_hash, google_id, is_active FROM users WHERE email = $1',
              [candidateEmail.toLowerCase()]
            );
            if (!racedUser.rows.length) {
              return res.status(409).json({ error: 'Candidate account changed during checkout. Please retry.' });
            }
            if (racedUser.rows[0].is_active === false) {
              return res.status(401).json({ error: 'This account is inactive. Contact support before starting checkout.' });
            }
            if (racedUser.rows[0].password_hash || racedUser.rows[0].google_id) {
              return res.status(409).json({
                error: 'An account with this email already exists. Please log in first to secure your registration.',
                requiresLogin: true
              });
            }
            userId = racedUser.rows[0].id;
          }
        }
      }

      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [courseId]);
        await client.query(
          `UPDATE orders SET status = 'expired', updated_at = NOW()
           WHERE course_id = $1 AND status = 'created'
             AND created_at < NOW() - INTERVAL '30 minutes'`,
          [courseId]
        );

        const courseRes = await client.query('SELECT cohort_deadline, max_seats, registrations_open FROM courses WHERE id = $1', [courseId]);
        if (!courseRes.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Course registration is not configured.' });
        }
        const course = courseRes.rows[0];
        const deadline = new Date(course.cohort_deadline);
        if (Date.now() > deadline.getTime()) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Cohort registration deadline has passed. Registrations are closed.' });
        }

        const existingEnrollment = await client.query(
          `SELECT id, plan_enrolled FROM enrollments WHERE user_id = $1 AND course_id = $2 AND status = 'active'`,
          [userId, courseId]
        );
        if (!course.registrations_open && !existingEnrollment.rows.length) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'New cohort registrations are currently closed.' });
        }
        if (existingEnrollment.rows.length && planKey === 'registration') {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'This candidate already has an active seat. Choose the course fee upgrade.' });
        }
        if (existingEnrollment.rows.some(enrollment => enrollment.plan_enrolled === 'course_fee') && planKey === 'course_fee') {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'This candidate already has an active course fee enrollment.' });
        }
        const pendingOrder = await client.query(
          `SELECT razorpay_order_id, plan_type FROM orders
           WHERE user_id = $1 AND course_id = $2 AND status = 'created'
             AND created_at >= NOW() - INTERVAL '30 minutes'
           ORDER BY created_at DESC`,
          [userId, courseId]
        );
        if (pendingOrder.rows.length) {
          if (pendingOrder.rows.some(pending => pending.plan_type !== planKey)) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'A checkout for a different plan is already pending. Complete it or wait for it to expire before choosing another plan.'
            });
          }
          await client.query('COMMIT');
          return res.json({
            orderId: pendingOrder.rows[0].razorpay_order_id,
            amount: plan.amountPaise,
            currency: 'INR',
            keyId,
            planName: plan.name,
            candidate: { name: candidateName, email: candidateEmail, phone: phone || '' }
          });
        }
        if (!existingEnrollment.rows.length) {
          const occupiedRes = await client.query(
            `SELECT COUNT(*)::int AS total FROM (
               SELECT user_id FROM enrollments WHERE course_id = $1 AND status = 'active'
               UNION
               SELECT user_id FROM orders WHERE course_id = $1 AND status = 'created'
                 AND created_at >= NOW() - INTERVAL '30 minutes'
             ) AS occupied`,
            [courseId]
          );
          const occupied = Number(occupiedRes.rows[0].total);
          const maxSeats = Number.isFinite(Number(course.max_seats)) ? Number(course.max_seats) : 25;
          if (occupied >= maxSeats) {
            await client.query('ROLLBACK');
            return res.status(403).json({
              error: `Cohort capacity reached (${occupied}/${maxSeats} seats reserved). Registrations are sold out.`
            });
          }
        }

        rzpOrderId = await createGatewayOrder(activeRzpInstance, plan, planKey, candidateEmail, company);
        await client.query(
          `INSERT INTO orders (razorpay_order_id, user_id, course_id, plan_type, amount, status)
           VALUES ($1, $2, $3, $4, $5, 'created')`,
          [rzpOrderId, userId, courseId, planKey, plan.amountPaise]
        );
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }
    } else {
      if (!userId) {
        const existingUser = Array.from(db.inMemoryStore.users ? db.inMemoryStore.users.values() : []).find(
          u => u.email && u.email.toLowerCase() === candidateEmail.toLowerCase()
        );
        if (existingUser && existingUser.is_active === false) {
          return res.status(401).json({ error: 'This account is inactive. Contact support before starting checkout.' });
        }
        if (existingUser && (existingUser.password_hash || existingUser.google_id)) {
          return res.status(409).json({
            error: 'An account with this email already exists. Please log in first to secure your registration.',
            requiresLogin: true
          });
        }
        if (existingUser) {
          userId = existingUser.id;
        } else {
          userId = 'usr_' + crypto.randomUUID();
          if (!db.inMemoryStore.users) db.inMemoryStore.users = new Map();
          db.inMemoryStore.users.set(candidateEmail.toLowerCase(), {
            id: userId,
            email: candidateEmail.toLowerCase(),
            full_name: candidateName || candidateEmail.split('@')[0],
            role: 'candidate'
          });
        }
      }

      const now = Date.now();
      const activeEnrollment = Array.from(db.inMemoryStore.enrollments.values()).find(enr =>
        enr.user_id === userId && (!enr.course_id || enr.course_id === courseId) && enr.status === 'active'
      );
      const registrationsOpen = (await adminRoutes.getAdminSetting('cohort_registrations_open', 'true')) === 'true';
      if (!registrationsOpen && !activeEnrollment) {
        return res.status(403).json({ error: 'New cohort registrations are currently closed.' });
      }
      if (activeEnrollment && planKey === 'registration') {
        return res.status(409).json({ error: 'This candidate already has an active seat. Choose the course fee upgrade.' });
      }
      if (activeEnrollment && activeEnrollment.plan_enrolled === 'course_fee' && planKey === 'course_fee') {
        return res.status(409).json({ error: 'This candidate already has an active course fee enrollment.' });
      }
      const pendingOrders = Array.from(db.inMemoryStore.orders.values()).filter(order => {
        const createdAt = order.created_at ? new Date(order.created_at).getTime() : now;
        return order.user_id === userId && order.course_id === courseId &&
          order.status === 'created' && now - createdAt < 30 * 60 * 1000;
      });
      if (pendingOrders.length) {
        if (pendingOrders.some(pending => pending.plan_type !== planKey)) {
          return res.status(409).json({
            error: 'A checkout for a different plan is already pending. Complete it or wait for it to expire before choosing another plan.'
          });
        }
        const pendingOrder = pendingOrders[0];
        return res.json({
          orderId: pendingOrder.razorpay_order_id,
          amount: plan.amountPaise,
          currency: 'INR',
          keyId,
          planName: plan.name,
          candidate: { name: candidateName, email: candidateEmail, phone: phone || '' }
        });
      }
      if (!activeEnrollment) {
        const occupiedUsers = new Set();
        for (const enr of db.inMemoryStore.enrollments.values()) {
          if (enr.course_id === courseId && enr.status === 'active') occupiedUsers.add(enr.user_id);
        }
        for (const pendingOrder of db.inMemoryStore.orders.values()) {
          const createdAt = pendingOrder.created_at ? new Date(pendingOrder.created_at).getTime() : now;
          if (pendingOrder.course_id === courseId && pendingOrder.status === 'created' && now - createdAt < 30 * 60 * 1000) {
            occupiedUsers.add(pendingOrder.user_id);
          } else if (pendingOrder.status === 'created') {
            pendingOrder.status = 'expired';
          }
        }
        const maxSeats = Number(await adminRoutes.getAdminSetting('cohort_max_seats', '25')) || 25;
        if (!occupiedUsers.has(userId) && occupiedUsers.size >= maxSeats) {
          return res.status(403).json({
            error: `Cohort capacity reached (${occupiedUsers.size}/${maxSeats} seats reserved). Registrations are sold out.`
          });
        }
      }
      rzpOrderId = await createGatewayOrder(activeRzpInstance, plan, planKey, candidateEmail, company);
      db.inMemoryStore.orders.set(rzpOrderId, {
        id: rzpOrderId,
        razorpay_order_id: rzpOrderId,
        user_id: userId,
        user_email: candidateEmail,
        course_id: courseId,
        plan_type: planKey,
        amount: plan.amountPaise,
        status: 'created',
        created_at: new Date().toISOString()
      });
    }

    res.json({
      orderId: rzpOrderId,
      amount: plan.amountPaise,
      currency: 'INR',
      keyId: keyId,
      planName: plan.name,
      candidate: {
        name: candidateName,
        email: candidateEmail,
        phone: phone || ''
      }
    });
  } catch (err) {
    console.error('Create Order Error:', err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to create payment order.' });
  }
});

// 2. VERIFY RAZORPAY PAYMENT (SERVER-SIDE HMAC SIGNATURE & CAPTURE VERIFICATION)
router.post('/verify', optionalAuth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const candidate_data = req.body.candidate_data || {
      name: req.body.name,
      email: req.body.email,
      phone: req.body.phone,
      company: req.body.company,
      gstin: req.body.gstin
    };

    if (!razorpay_order_id || !razorpay_payment_id) {
      return res.status(400).json({ error: 'Missing payment verification parameters.' });
    }

    // 1. High Issue 2 Fix: Confirm server order record exists first
    let order = null;
    if (db.hasDb()) {
      const oRes = await db.query('SELECT * FROM orders WHERE razorpay_order_id = $1', [razorpay_order_id]);
      if (oRes.rows.length > 0) {
        order = oRes.rows[0];
      }
    } else {
      order = db.inMemoryStore.orders.get(razorpay_order_id);
    }

    if (!order) {
      return res.status(404).json({
        error: 'Order record not found on server. Verification cannot proceed without a valid server-side order.'
      });
    }

    if (order.status === 'expired' || order.status === 'failed') {
      return res.status(409).json({ error: 'This payment order is no longer active. Please start a new checkout.' });
    }
    if (order.status === 'paid' && order.razorpay_payment_id !== razorpay_payment_id) {
      return res.status(409).json({ error: 'This order has already been fulfilled by another payment.' });
    }
    if (order.status !== 'created' && order.status !== 'paid') {
      return res.status(409).json({ error: 'This payment order is not active.' });
    }
    if (order.status === 'created' && order.created_at && Date.now() - new Date(order.created_at).getTime() > 30 * 60 * 1000) {
      if (db.hasDb()) {
        await db.query("UPDATE orders SET status = 'expired', updated_at = NOW() WHERE id = $1 AND status = 'created'", [order.id]);
      } else {
        order.status = 'expired';
      }
      return res.status(410).json({ error: 'This payment order expired. Please start a new checkout.' });
    }

    const { keySecret: activeKeySecret, instance: activeRzpInstance } = await getActiveRazorpayConfig();
    const isProduction = process.env.NODE_ENV === 'production';

    // 2. Check Cryptographic Signature
    if (isProduction) {
      if (!activeKeySecret) {
        return res.status(503).json({ error: 'Payment gateway secret is not configured on the production server.' });
      }
      if (!activeRzpInstance) {
        return res.status(503).json({ error: 'Payment gateway is not configured on the production server.' });
      }
      if (!razorpay_signature) {
        return res.status(400).json({ error: 'Missing payment signature verification parameter.' });
      }
      const generatedSignature = crypto
        .createHmac('sha256', activeKeySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      if (!safeCompareSignatures(generatedSignature, razorpay_signature)) {
        return res.status(400).json({ error: 'Payment signature verification failed. Fraud alert.' });
      }
    } else {
      if (activeKeySecret && razorpay_signature) {
        const generatedSignature = crypto
          .createHmac('sha256', activeKeySecret)
          .update(`${razorpay_order_id}|${razorpay_payment_id}`)
          .digest('hex');

        if (!safeCompareSignatures(generatedSignature, razorpay_signature)) {
          return res.status(400).json({ error: 'Payment signature verification failed. Fraud alert.' });
        }
      } else {
        console.warn('⚠️ Razorpay Key Secret not configured yet. Verifying payment in sandbox development mode.');
      }
    }

    // 3. Confirm captured status and amount with Razorpay API (Razorpay Integration Guidance)
    if (activeRzpInstance) {
      try {
        const paymentDetails = await activeRzpInstance.payments.fetch(razorpay_payment_id);
        if (!paymentDetails) {
          return res.status(400).json({ error: 'Payment details could not be retrieved from Razorpay.' });
        }

        // Verify order ID held by server matches the payment entity
        if (paymentDetails.order_id !== order.razorpay_order_id) {
          return res.status(400).json({ error: 'Payment order ID does not match server order record.' });
        }

        // Verify captured amount and currency match the server order.
        if (Number(paymentDetails.amount) !== Number(order.amount)) {
          return res.status(400).json({ error: 'Payment amount mismatch between client payment and server order.' });
        }
        if (paymentDetails.currency !== (order.currency || 'INR')) {
          return res.status(400).json({ error: 'Payment currency does not match the server order.' });
        }

        // Check captured status
        if (paymentDetails.status !== 'captured') {
          if (paymentDetails.status === 'authorized') {
            try {
              await activeRzpInstance.payments.capture(razorpay_payment_id, order.amount, 'INR');
              const capturedPayment = await activeRzpInstance.payments.fetch(razorpay_payment_id);
              if (!capturedPayment || capturedPayment.status !== 'captured' ||
                  capturedPayment.order_id !== order.razorpay_order_id ||
                  Number(capturedPayment.amount) !== Number(order.amount) ||
                  capturedPayment.currency !== (order.currency || 'INR')) {
                return res.status(402).json({ error: 'Payment capture could not be confirmed with the gateway. Access cannot be granted yet.' });
              }
            } catch (capErr) {
              console.error('Failed to capture authorized payment:', capErr);
              return res.status(402).json({ error: 'Payment authorized but capture failed. Access cannot be granted yet.' });
            }
          } else {
            return res.status(402).json({ error: `Payment not captured (current status: ${paymentDetails.status}). Cannot fulfill order.` });
          }
        }
      } catch (fetchErr) {
        console.error('Razorpay payment fetch error:', fetchErr);
        return res.status(400).json({ error: `Failed to confirm payment capture with Razorpay: ${fetchErr.message}` });
      }
    }

    // 4. Resolve Target User and Fulfill Enrollment inside an ACID SQL Transaction
    const candidateEmail = (candidate_data && candidate_data.email) || (req.user && req.user.email) || order.user_email || '';
    const candidateName = (candidate_data && candidate_data.name) || (req.user && req.user.name) || 'Enrolled Candidate';
    let targetUser = null;
    let enrollment = null;

    if (db.hasDb()) {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');

        const lockedOrderRes = await client.query(
          'SELECT status, razorpay_payment_id, created_at FROM orders WHERE id = $1 FOR UPDATE',
          [order.id]
        );
        const lockedOrder = lockedOrderRes.rows[0];
        if (!lockedOrder) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Payment order no longer exists.' });
        }

        if (lockedOrder.status === 'paid' && lockedOrder.razorpay_payment_id === razorpay_payment_id) {
          const userRes = await client.query(
            'SELECT id, email, full_name, role, password_hash, google_id FROM users WHERE id = $1',
            [order.user_id]
          );
          const enrollmentRes = await client.query(
            'SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2',
            [order.user_id, order.course_id]
          );
          if (!userRes.rows.length || !enrollmentRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(500).json({ error: 'Paid order fulfillment record is incomplete.' });
          }
          targetUser = userRes.rows[0];
          enrollment = enrollmentRes.rows[0];
          await client.query('COMMIT');
        } else {
          if (lockedOrder.status !== 'created') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'This payment order was already processed.' });
          }
          if (Date.now() - new Date(lockedOrder.created_at).getTime() > 30 * 60 * 1000) {
            await client.query("UPDATE orders SET status = 'expired', updated_at = NOW() WHERE id = $1", [order.id]);
            await client.query('COMMIT');
            return res.status(410).json({ error: 'This payment order expired. Please start a new checkout.' });
          }

          const paidOrderRes = await client.query(
            `UPDATE orders
             SET status = 'paid', razorpay_payment_id = $1, razorpay_signature = $2, updated_at = NOW()
             WHERE id = $3 AND status = 'created' RETURNING id`,
            [razorpay_payment_id, razorpay_signature || 'simulated', order.id]
          );
          if (!paidOrderRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'This payment order was already processed.' });
          }

        // Resolve user
        if (order.user_id) {
          const uRes = await client.query('SELECT id, email, full_name, role, password_hash, google_id FROM users WHERE id = $1', [order.user_id]);
          if (uRes.rows.length > 0) targetUser = uRes.rows[0];
        }
        if (!targetUser) {
          const uRes = await client.query('SELECT id, email, full_name, role, password_hash, google_id FROM users WHERE email = $1', [candidateEmail.toLowerCase()]);
          if (uRes.rows.length > 0) targetUser = uRes.rows[0];
        }

        if (!targetUser) {
          await client.query('ROLLBACK');
          return res.status(500).json({ error: 'Associated candidate user record could not be resolved.' });
        }

        // Check if candidate already has an enrollment for this course to preserve existing registration number
        const courseId = order.course_id || 'ai-infrastructure-factory';
        const existingEnr = await client.query(
          'SELECT registration_number FROM enrollments WHERE user_id = $1 AND course_id = $2',
          [targetUser.id, courseId]
        );

        const regNumber = existingEnr.rows.length > 0
          ? existingEnr.rows[0].registration_number
          : await generateUniqueRegistrationNumber(client);

        const isCourseFee = (order.plan_type === 'course_fee');

        // Upsert enrollment: upgrade plan_enrolled and cluster_ssh_granted if paying course fee
        const enrRes = await client.query(
          `INSERT INTO enrollments (registration_number, user_id, course_id, order_id, plan_enrolled, status, unlocked_content, cluster_ssh_granted)
           VALUES ($1, $2, $3, $4, $5, 'active', TRUE, $6)
           ON CONFLICT (user_id, course_id) DO UPDATE SET 
             plan_enrolled = CASE 
               WHEN EXCLUDED.plan_enrolled = 'course_fee' THEN 'course_fee'
               ELSE enrollments.plan_enrolled
             END,
             cluster_ssh_granted = CASE
               WHEN EXCLUDED.plan_enrolled = 'course_fee' THEN TRUE
               ELSE enrollments.cluster_ssh_granted
             END,
             order_id = EXCLUDED.order_id,
             status = 'active',
             unlocked_content = TRUE
           RETURNING *`,
          [regNumber, targetUser.id, courseId, order.id, order.plan_type, isCourseFee]
        );
        enrollment = enrRes.rows[0];

          await client.query('COMMIT');
        }
      } catch (txErr) {
        await client.query('ROLLBACK');
        console.error('Database transaction error in payment verification:', txErr);
        throw txErr;
      } finally {
        client.release();
      }
    } else {
      // In-memory fallback
      order.status = 'paid';
      order.razorpay_payment_id = razorpay_payment_id;
      db.inMemoryStore.orders.set(order.razorpay_order_id, order);

      targetUser = db.inMemoryStore.users
        ? Array.from(db.inMemoryStore.users.values()).find(user => user.id === order.user_id)
        : null;
      if (!targetUser) {
        targetUser = {
          id: order.user_id || ('usr_' + Date.now()),
          email: order.user_email || candidateEmail,
          name: candidateName,
          role: 'candidate'
        };
      }

      // Check existing in-memory enrollment
      for (const [_, enr] of db.inMemoryStore.enrollments) {
        if (enr.user_id === targetUser.id && (!enr.course_id || enr.course_id === order.course_id)) {
          enr.plan_enrolled = (order.plan_type === 'course_fee' || enr.plan_enrolled === 'course_fee') ? 'course_fee' : 'registration';
          enr.cluster_ssh_granted = order.plan_type === 'course_fee' || Boolean(enr.cluster_ssh_granted);
          enr.order_id = order.id;
          enr.status = 'active';
          enr.unlocked_content = true;
          enrollment = enr;
          break;
        }
      }

      if (!enrollment) {
        const regNumber = generateUniqueMemoryRegistrationNumber();
        enrollment = {
          registration_number: regNumber,
          user_id: targetUser.id,
          user_email: targetUser.email,
          course_id: order.course_id,
          order_id: order.id,
          plan_enrolled: order.plan_type,
          status: 'active',
          unlocked_content: true,
          cluster_ssh_granted: (order.plan_type === 'course_fee'),
          enrolled_at: new Date().toISOString()
        };
        db.inMemoryStore.enrollments.set(regNumber, enrollment);
      }
    }

    if (!enrollment || !enrollment.registration_number) {
      return res.status(500).json({ error: 'Payment was confirmed but the enrollment record is missing. Contact support before retrying payment.' });
    }

    // 5. Account Takeover Prevention: Only issue JWT token if:
    // (a) Request is already authenticated as the account owner (req.user.id === targetUser.id), OR
    // (b) Target user has NO credentials (guest account created in this checkout flow).
    const isCallerAuthenticatedAsOwner = req.user && req.user.id === targetUser.id;
    const targetHasCredentials = Boolean(targetUser.password_hash || targetUser.google_id);

    let token = null;
    if (isCallerAuthenticatedAsOwner || !targetHasCredentials) {
      token = jwt.sign(
        {
          id: targetUser.id,
          email: targetUser.email,
          role: targetUser.role || 'candidate',
          name: targetUser.full_name || targetUser.name || candidateName
        },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
    } else {
      console.warn(`🔒 Protected account: Suppressed token issuance for ${targetUser.email} because verification request was not authenticated as that user.`);
    }

    res.json({
      success: true,
      message: token ? 'Payment verified and cohort seat secured.' : 'Payment verified! Please sign in with your credentials to access your classroom.',
      requiresLogin: !token,
      token: token || undefined,
      user: token ? {
        id: targetUser.id,
        email: targetUser.email,
        name: targetUser.full_name || targetUser.name || candidateName,
        role: targetUser.role || 'candidate'
      } : undefined,
      enrollment: {
        registrationId: enrollment.registration_number,
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id,
        planEnrolled: (enrollment && enrollment.plan_enrolled) || order.plan_type,
        clusterSshGranted: Boolean(enrollment && enrollment.cluster_ssh_granted),
        candidateName: targetUser.full_name || targetUser.name || candidateName,
        candidateEmail: targetUser.email,
        status: 'Confirmed'
      }
    });
  } catch (err) {
    console.error('Payment Verification Error:', err);
    res.status(500).json({ error: 'Server error during payment verification.' });
  }
});

// 3. SECURE RAZORPAY WEBHOOK RECEIVER (SOURCE OF TRUTH)
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const { webhookSecret: activeWebhookSecret } = await getActiveRazorpayConfig();
    const webhookSecret = activeWebhookSecret || RZP_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error('❌ Webhook rejected: RAZORPAY_WEBHOOK_SECRET is not configured on the server.');
      return res.status(503).json({ error: 'Webhook processing unavailable: Secret not configured.' });
    }

    if (!signature) {
      console.error('❌ Webhook rejected: Missing x-razorpay-signature header.');
      return res.status(400).json({ error: 'Missing x-razorpay-signature header.' });
    }

    const rawPayload = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawPayload)
      .digest('hex');

    if (!safeCompareSignatures(expectedSignature, signature)) {
      console.error('❌ Webhook signature verification failed.');
      return res.status(400).send('Invalid webhook signature');
    }

    const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    console.log(`✓ Webhook event received: ${event.event}`);

    if (event.event === 'payment.captured' || event.event === 'order.paid') {
      const payment = event.payload && event.payload.payment ? event.payload.payment.entity : null;
      if (payment) {
        const orderId = payment.order_id;
        const paymentId = payment.id;

        if (db.hasDb()) {
          const client = await db.pool.connect();
          try {
            await client.query('BEGIN');
            const oRes = await client.query(
              'SELECT * FROM orders WHERE razorpay_order_id = $1 FOR UPDATE',
              [orderId]
            );
            const order = oRes.rows[0];
            if (!order) {
              await client.query('COMMIT');
              return res.status(404).json({ error: 'Webhook order was not found.' });
            }
            if (Number(payment.amount) !== Number(order.amount) || payment.currency !== (order.currency || 'INR')) {
              await client.query('ROLLBACK');
              return res.status(400).json({ error: 'Webhook payment amount or currency does not match the server order.' });
            }
            if (order.status === 'paid') {
              if (order.razorpay_payment_id !== paymentId) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Order was already fulfilled by a different payment.' });
              }
              await client.query('COMMIT');
            } else if (order.status === 'created') {
              const paidOrder = await client.query(
                `UPDATE orders SET status = 'paid', razorpay_payment_id = $1, updated_at = NOW()
                 WHERE id = $2 AND status = 'created' RETURNING *`,
                [paymentId, order.id]
              );
              if (!paidOrder.rows.length) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Order status changed while processing the payment.' });
              }
              const paid = paidOrder.rows[0];
              const courseId = paid.course_id || 'ai-infrastructure-factory';
              const isCourseFee = (paid.plan_type === 'course_fee');

              const existingEnr = await client.query(
                'SELECT registration_number FROM enrollments WHERE user_id = $1 AND course_id = $2',
                [paid.user_id, courseId]
              );
              const regNumber = existingEnr.rows.length > 0
                ? existingEnr.rows[0].registration_number
                : await generateUniqueRegistrationNumber(client);

              await client.query(
                `INSERT INTO enrollments (registration_number, user_id, course_id, order_id, plan_enrolled, status, unlocked_content, cluster_ssh_granted)
                 VALUES ($1, $2, $3, $4, $5, 'active', TRUE, $6)
                 ON CONFLICT (user_id, course_id) DO UPDATE SET
                   plan_enrolled = CASE
                     WHEN EXCLUDED.plan_enrolled = 'course_fee' THEN 'course_fee'
                     ELSE enrollments.plan_enrolled
                   END,
                   cluster_ssh_granted = CASE
                     WHEN EXCLUDED.plan_enrolled = 'course_fee' THEN TRUE
                     ELSE enrollments.cluster_ssh_granted
                   END,
                   order_id = EXCLUDED.order_id,
                   status = 'active',
                   unlocked_content = TRUE`,
                [regNumber, paid.user_id, courseId, paid.id, paid.plan_type, isCourseFee]
              );
              await client.query('COMMIT');
            } else {
              await client.query('ROLLBACK');
              return res.status(409).json({ error: 'Webhook order is not active.' });
            }
          } catch (txErr) {
            await client.query('ROLLBACK');
            console.error('Webhook database transaction error:', txErr);
            throw txErr;
          } finally {
            client.release();
          }
        } else {
          const order = db.inMemoryStore.orders.get(orderId);
          if (order && Number(payment.amount) === Number(order.amount) && payment.currency === (order.currency || 'INR') && order.status === 'created') {
            order.status = 'paid';
            order.razorpay_payment_id = paymentId;
            db.inMemoryStore.orders.set(orderId, order);
            let enrollment = null;
            for (const [_, enr] of db.inMemoryStore.enrollments) {
              if (enr.user_id === order.user_id && (!enr.course_id || enr.course_id === order.course_id)) {
                enr.plan_enrolled = (order.plan_type === 'course_fee' || enr.plan_enrolled === 'course_fee') ? 'course_fee' : 'registration';
                enr.cluster_ssh_granted = order.plan_type === 'course_fee' || Boolean(enr.cluster_ssh_granted);
                enr.order_id = order.id;
                enr.status = 'active';
                enr.unlocked_content = true;
                enrollment = enr;
                break;
              }
            }
            if (!enrollment) {
              const user = Array.from(db.inMemoryStore.users.values()).find(candidate => candidate.id === order.user_id);
              const regNumber = generateUniqueMemoryRegistrationNumber();
              db.inMemoryStore.enrollments.set(regNumber, {
                registration_number: regNumber,
                user_id: order.user_id,
                user_email: user ? user.email : order.user_email,
                course_id: order.course_id || 'ai-infrastructure-factory',
                order_id: order.id,
                plan_enrolled: order.plan_type,
                status: 'active',
                unlocked_content: true,
                cluster_ssh_granted: order.plan_type === 'course_fee',
                enrolled_at: new Date().toISOString()
              });
            }
          }
        }
      }
    } else if (event.event === 'payment.failed') {
      const payment = event.payload && event.payload.payment ? event.payload.payment.entity : null;
      if (payment && payment.order_id) {
        // A failed payment attempt does not fail the Razorpay order; the user may retry it.
        console.log(`Razorpay payment attempt failed for order ${payment.order_id}.`);
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Webhook processing error');
  }
});

// 4. POLL PAYMENT ORDER STATUS (Decoupled Handoff Pattern from SellYourSaaS / Skateshop)
router.get('/status/:orderId', requireAuth, async (req, res) => {
  try {
    const orderId = req.params.orderId;
    if (!orderId) {
      return res.status(400).json({ error: 'Order ID is required' });
    }

    if (db.hasDb()) {
      const oRes = await db.query('SELECT * FROM orders WHERE razorpay_order_id = $1', [orderId]);
      if (oRes.rows.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }
      const order = oRes.rows[0];
      if (req.user.role !== 'admin' && order.user_id !== req.user.id) {
        return res.status(404).json({ error: 'Order not found' });
      }
      if (order.status === 'created' && order.created_at && Date.now() - new Date(order.created_at).getTime() > 30 * 60 * 1000) {
        await db.query("UPDATE orders SET status = 'expired', updated_at = NOW() WHERE id = $1 AND status = 'created'", [order.id]);
        order.status = 'expired';
      }

      let enrollment = null;
      if (order.status === 'paid') {
        const eRes = await db.query('SELECT * FROM enrollments WHERE order_id = $1', [order.id]);
        if (eRes.rows.length > 0) enrollment = eRes.rows[0];
      }

      return res.json({
        orderId: order.razorpay_order_id,
        status: order.status,
        planType: order.plan_type,
        amount: order.amount,
        enrollment: enrollment ? {
          regId: enrollment.registration_number,
          status: enrollment.status,
          enrolledAt: enrollment.enrolled_at
        } : null
      });
    } else {
      const order = db.inMemoryStore.orders.get(orderId);
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }
      if (req.user.role !== 'admin' && order.user_id !== req.user.id) {
        return res.status(404).json({ error: 'Order not found' });
      }
      if (order.status === 'created' && order.created_at && Date.now() - new Date(order.created_at).getTime() > 30 * 60 * 1000) {
        order.status = 'expired';
        db.inMemoryStore.orders.set(orderId, order);
      }
      let enrollment = null;
      if (order.status === 'paid') {
        for (const [_, enr] of db.inMemoryStore.enrollments) {
          if (enr.order_id === order.id || enr.user_id === order.user_id) {
            enrollment = enr;
            break;
          }
        }
      }
      return res.json({
        orderId: order.razorpay_order_id,
        status: order.status,
        planType: order.plan_type,
        amount: order.amount,
        enrollment: enrollment ? {
          regId: enrollment.registration_number,
          status: enrollment.status,
          enrolledAt: enrollment.enrolled_at
        } : null
      });
    }
  } catch (err) {
    console.error('Check order status error:', err);
    res.status(500).json({ error: 'Failed to query order status' });
  }
});

module.exports = router;
