const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const Paper = require('../models/Paper');
const Submission = require('../models/Submission');
const { requireAdmin, validateIdParam } = require('../middleware/auth');
const brevoMailPool = require('../utils/brevoMailPool');
const {
    startWhatsAppDispatchJob,
    getJobStatus,
    cancelJob
} = require('../services/whatsappResultsService');

router.param('id', validateIdParam);

// Helper to mask email address for security: lokesh... -> l***@gmail.com
function maskEmail(email) {
    if (!email || !email.includes('@')) return 'admin@email';
    const [local, domain] = email.split('@');
    if (local.length <= 2) {
        return `${local[0]}*@${domain}`;
    }
    return `${local[0]}***${local.slice(-1)}@${domain}`;
}

/**
 * Step 1: Request 6-digit OTP sent to the logged-in administrator's email
 */
router.post('/request-otp/:id', requireAdmin, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) {
            return res.status(404).json({ success: false, error: 'Paper not found.' });
        }

        const submissionCount = await Submission.countDocuments({
            $or: [
                { paper_id: String(paper._id) },
                { paper_id: paper._id }
            ]
        });

        if (submissionCount === 0) {
            return res.status(400).json({
                success: false,
                error: 'No evaluated student copies found for this paper. Please scan or evaluate papers first.'
            });
        }

        // Determine destination admin email (authenticated user's email, or configured admin email)
        const destEmail = (req.user && req.user.email && req.user.email.trim()) ||
            (process.env.ADMIN_EMAIL && process.env.ADMIN_EMAIL.trim()) ||
            'lokeshbadgujjar401@gmail.com';

        if (!destEmail) {
            return res.status(400).json({
                success: false,
                error: 'No administrator email address found to send verification OTP.'
            });
        }

        // Generate cryptographically secure 6-digit numeric OTP
        const otp = crypto.randomInt(100000, 1000000).toString();
        const otpHash = crypto.createHash('sha256').update(otp).digest('hex');

        // Store OTP hash and metadata in admin session (expires in 10 minutes)
        req.session.whatsappDispatchOtp = {
            hash: otpHash,
            paperId: String(paper._id),
            expiresAt: Date.now() + 10 * 60 * 1000,
            attempts: 0
        };

        // Send email via Brevo Mail Pool
        const adminName = (req.user && (req.user.fullName || req.user.username)) || 'Administrator';
        await brevoMailPool.sendDispatchOtpEmail({
            toEmail: destEmail,
            toName: adminName,
            otp: otp,
            paperTitle: paper.title,
            totalStudents: submissionCount,
            expiresMinutes: 10
        });

        return res.json({
            success: true,
            message: `Verification OTP sent to ${maskEmail(destEmail)}.`,
            emailHint: maskEmail(destEmail),
            totalStudents: submissionCount
        });
    } catch (err) {
        console.error('[WhatsApp Request OTP Error]:', err);
        return res.status(500).json({
            success: false,
            error: err.message || 'Failed to generate and send OTP email.'
        });
    }
});

/**
 * Step 2: Verify OTP and trigger background WhatsApp result dispatch
 */
router.post('/verify-and-dispatch/:id', requireAdmin, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) {
            return res.status(404).json({ success: false, error: 'Paper not found.' });
        }

        const providedOtp = String((req.body && req.body.otp) || '').trim();
        if (!providedOtp || !/^\d{6}$/.test(providedOtp)) {
            return res.status(400).json({
                success: false,
                error: 'Please enter a valid 6-digit numeric OTP.'
            });
        }

        const sessionOtp = req.session.whatsappDispatchOtp;
        if (!sessionOtp || sessionOtp.paperId !== String(paper._id)) {
            return res.status(400).json({
                success: false,
                error: 'No active OTP verification session found for this paper. Please request a new OTP.'
            });
        }

        // Check expiration
        if (Date.now() > sessionOtp.expiresAt) {
            delete req.session.whatsappDispatchOtp;
            return res.status(400).json({
                success: false,
                error: 'The verification OTP has expired. Please request a new code.'
            });
        }

        // Check brute-force attempts
        sessionOtp.attempts = (sessionOtp.attempts || 0) + 1;
        if (sessionOtp.attempts > 5) {
            delete req.session.whatsappDispatchOtp;
            return res.status(400).json({
                success: false,
                error: 'Too many invalid attempts. For security, this OTP has been invalidated. Please request a new code.'
            });
        }

        // Verify cryptographic hash
        const providedHash = crypto.createHash('sha256').update(providedOtp).digest('hex');
        let isValid = false;
        try {
            isValid = crypto.timingSafeEqual(
                Buffer.from(providedHash, 'hex'),
                Buffer.from(sessionOtp.hash, 'hex')
            );
        } catch (_) {
            isValid = false;
        }

        if (!isValid) {
            return res.status(400).json({
                success: false,
                error: `Invalid OTP code. Please verify the code sent to your email (${6 - sessionOtp.attempts} attempts remaining).`
            });
        }

        // Single-use guarantee: Invalidate OTP immediately
        delete req.session.whatsappDispatchOtp;

        // Start background dispatch job
        const job = await startWhatsAppDispatchJob(paper._id, req.user);

        return res.json({
            success: true,
            jobId: job.id,
            total: job.total,
            message: `Dispatch job initialized for ${job.total} students.`
        });
    } catch (err) {
        console.error('[WhatsApp Verify & Dispatch Error]:', err);
        return res.status(500).json({
            success: false,
            error: err.message || 'Failed to start dispatch job.'
        });
    }
});

/**
 * Step 3: Poll live progress of an active dispatch job
 */
router.get('/job-status/:jobId', requireAdmin, (req, res) => {
    const job = getJobStatus(req.params.jobId);
    if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found or expired.' });
    }

    return res.json({
        success: true,
        job: {
            id: job.id,
            paperTitle: job.paperTitle,
            total: job.total,
            sent: job.sent,
            failed: job.failed,
            skipped: job.skipped,
            status: job.status,
            currentStudent: job.currentStudent,
            startTime: job.startTime,
            completedTime: job.completedTime,
            logs: job.logs.slice(-15) // send last 15 log entries
        }
    });
});

/**
 * Cancel an active dispatch job
 */
router.post('/cancel-job/:jobId', requireAdmin, (req, res) => {
    const success = cancelJob(req.params.jobId);
    return res.json({
        success,
        message: success ? 'Dispatch job has been requested to stop.' : 'Job could not be cancelled (may be already finished).'
    });
});

module.exports = router;
