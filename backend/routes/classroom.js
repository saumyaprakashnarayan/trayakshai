const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireEnrollment } = require('../middleware/auth');

// 1. GET ALL UNLOCKED MODULES FOR ENROLLED CANDIDATES
router.get('/modules', requireEnrollment, async (req, res) => {
  try {
    let modules = [];

    if (db.hasDb()) {
      const result = await db.query(
        `SELECT id, track_number, track_title, lesson_title, lesson_type, duration, video_url, attachment, attachment_content, description, sort_order
         FROM modules
         WHERE course_id = 'ai-infrastructure-factory' AND is_published = TRUE
         ORDER BY sort_order ASC, track_number ASC`
      );
      modules = result.rows;
    } else {
      modules = Array.from(db.inMemoryStore.modules.values()).sort((a, b) => a.sort_order - b.sort_order);
    }

    res.json({
      success: true,
      course: 'AI Infrastructure & AI Factory Training',
      enrollment: req.enrollment ? {
        regId: req.enrollment.registration_number,
        plan: req.enrollment.plan_enrolled,
        clusterSshGranted: Boolean(req.enrollment.cluster_ssh_granted)
      } : { regId: 'ADMIN-VERIFIED', plan: 'admin', clusterSshGranted: false },
      modules
    });
  } catch (err) {
    console.error('Fetch classroom modules error:', err);
    res.status(500).json({ error: 'Failed to retrieve course modules.' });
  }
});

// 2. SECURE RUNBOOK / BLUEPRINT DOWNLOAD ENDPOINT
router.get('/blueprint/:id', requireEnrollment, async (req, res) => {
  try {
    const moduleId = req.params.id;
    let mod = null;

    if (db.hasDb()) {
      const result = await db.query(
        `SELECT * FROM modules
         WHERE id = $1 AND course_id = 'ai-infrastructure-factory' AND is_published = TRUE`,
        [moduleId]
      );
      if (result.rows.length > 0) mod = result.rows[0];
    } else {
      mod = db.inMemoryStore.modules.get(moduleId);
    }

    if (!mod) {
      return res.status(404).json({ error: 'Requested blueprint or runbook does not exist.' });
    }

    if (!mod.attachment_content) {
      return res.status(404).json({ error: 'This lesson does not have a downloadable blueprint yet.' });
    }

    res.json({
      success: true,
      filename: mod.attachment || `${mod.lesson_title || 'course-blueprint'}.md`,
      blueprintContent: mod.attachment_content
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate blueprint.' });
  }
});

// 3. SECURE BARE-METAL LAB CLUSTER TELEMETRY / SHELL EXECUTION
router.post('/lab-exec', requireEnrollment, async (req, res) => {
  try {
    const isSuperAdmin = req.user && req.user.role === 'admin';
    const isSshGranted = req.enrollment && req.enrollment.cluster_ssh_granted;
    const isFullCoursePaid = req.enrollment && req.enrollment.plan_enrolled === 'course_fee';

    if (!isSuperAdmin && !isSshGranted && !isFullCoursePaid) {
      return res.status(403).json({
        error: 'Forbidden: Bare-metal cluster diagnostics and SSH execution require Course Fee payment or instructor cluster assignment.',
        requiredPlan: 'course_fee',
        currentPlan: req.enrollment ? req.enrollment.plan_enrolled : 'registration'
      });
    }

    const rawCmd = (req.body.command || '').trim();
    if (!rawCmd) {
      return res.status(400).json({ error: 'Command parameter is required.' });
    }

    const allowedCommands = new Set([
      'nvidia-smi', 'squeue', 'ibstat', 'dcgm', 'uptime', 'free', 'free -h', 'free -m',
      'uname -a', 'whoami', 'cat /etc/os-release', 'help', 'clear'
    ]);
    if (!allowedCommands.has(rawCmd.toLowerCase())) {
      return res.status(400).json({ error: 'Command is not in the approved diagnostics list.' });
    }

    const executionUrl = process.env.LAB_EXECUTION_URL;
    const executionToken = process.env.LAB_EXECUTION_TOKEN;
    if (!executionUrl || !executionToken) {
      return res.status(503).json({ error: 'Live lab execution is not configured. No simulated output was returned.' });
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 10000);
    try {
      const executionResponse = await fetch(`${executionUrl.replace(/\/+$/, '')}/v1/diagnostics`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${executionToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          command: rawCmd,
          candidate: {
            id: req.user.id,
            email: req.user.email,
            name: req.user.name,
            registrationNumber: (req.enrollment && req.enrollment.registration_number) || null
          }
        }),
        signal: abortController.signal
      });
      const result = await executionResponse.json().catch(() => ({}));
      if (!executionResponse.ok || typeof result.output !== 'string') {
        return res.status(502).json({ error: 'Lab execution service could not complete the diagnostic command.' });
      }
      return res.json({
        success: true,
        command: rawCmd,
        output: result.output,
        node: result.node || 'cluster'
      });
    } finally {
      clearTimeout(timeout);
    }

  } catch (err) {
    console.error('Lab command execution error:', err);
    res.status(500).json({ error: 'Failed to process cluster telemetry command.' });
  }
});

module.exports = router;

