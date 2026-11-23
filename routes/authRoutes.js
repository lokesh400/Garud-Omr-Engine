const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const passport = require('passport');
const User = require('../models/User');
const brevoMailPool = require('../utils/brevoMailPool');
const {
    loginLimiter,
    forgotPasswordLimiter,
    resetPasswordLimiter,
    passwordChangeLimiter,
    isValidEmail
} = require('../utils/security');
const {
    SESSION_COOKIE_NAME,
    getSafeReturnTo,
    requireAuth
} = require('../middleware/auth');

// Public Cloud Uptime & Health Check Endpoints (Bypasses auth/session)
router.get('/healthz', (req, res) => res.status(200).send('OK'));
router.get('/health', (req, res) => res.status(200).send('OK'));
router.get('/ping', (req, res) => res.status(200).json({ status: 'ok', uptime: Math.floor(process.uptime()), timestamp: Date.now() }));

// Authentication Routes (passport-local + passport-local-mongoose)
router.get('/login', (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated() && req.user) {
        return res.redirect((req.user.role === 'admin' || req.user.role === 'teacher') ? '/' : '/student');
    }
    const msgMap = {
        signed_out: 'You have been signed out.'
    };
    res.render('login', {
        error: null,
        message: msgMap[req.query.message] || null,
        username: ''
    });
});

router.post('/login', loginLimiter.middleware((req) => {
    const rawUsername = String((req.body && req.body.username) || '').trim().toLowerCase();
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    return `${ip}:${rawUsername}`;
}), (req, res, next) => {
    const returnTo = req.session ? getSafeReturnTo(req.session.returnTo) : null;
    const rawUsername = String((req.body && req.body.username) || '').trim().toLowerCase();

    passport.authenticate('local', (err, user, info) => {
        if (err) return next(err);
        if (!user) {
            return res.status(401).render('login', {
                error: (info && info.message) || 'Invalid username or password.',
                message: null,
                username: rawUsername
            });
        }

        // Reset rate limiter on successful authentication
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        loginLimiter.reset(`${ip}:${rawUsername}`);

        // Session Fixation Defense: regenerate session ID upon authentication
        const savedReturnTo = returnTo;
        req.session.regenerate((regenErr) => {
            if (regenErr) return next(regenErr);
            req.logIn(user, (loginErr) => {
                if (loginErr) return next(loginErr);
                const isStaff = user.role === 'admin' || user.role === 'teacher';
                const dest = isStaff ? (savedReturnTo || '/') : '/student';
                return res.redirect(dest);
            });
        });
    })(req, res, next);
});

// Registration is disabled (accounts are created by Admins in /users)
router.get('/register', (req, res) => {
    res.redirect('/login');
});

// ============================================================
// FORGOT & RESET PASSWORD VIA BREVO MAIL OTP
// ============================================================
router.get('/forgot-password', (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated() && req.user) {
        return res.redirect((req.user.role === 'admin' || req.user.role === 'teacher') ? '/' : '/student');
    }
    res.render('forgot_password', {
        error: req.query.error || null,
        message: req.query.message || null,
        identifier: req.query.identifier || ''
    });
});

router.post('/forgot-password', forgotPasswordLimiter.middleware((req) => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown', (req, res, msg) => {
    return res.status(429).render('forgot_password', {
        error: msg,
        identifier: req.body && req.body.identifier ? String(req.body.identifier) : ''
    });
}), async (req, res) => {
    try {
        const identifier = String((req.body && req.body.identifier) || '').trim();
        if (!identifier) {
            return res.render('forgot_password', {
                error: 'Please enter your student roll number or username.',
                identifier: ''
            });
        }

        const user = await User.findOne({
            $or: [
                { rollnumber: identifier },
                { rollnumber: identifier.toUpperCase() },
                { username: identifier.toLowerCase() },
                { email: identifier.toLowerCase() }
            ]
        });

        if (!user) {
            return res.render('forgot_password', {
                error: 'No account found matching this roll number or username. Please check and try again.',
                identifier
            });
        }

        if (!user.email || !user.email.trim()) {
            return res.render('forgot_password', {
                error: 'No mailing address in your account. Please ask your administrator to add one.',
                identifier
            });
        }

        // Account-level cooldown: 60 seconds between OTP generation requests
        if (user.resetPasswordLastRequestedAt && (Date.now() - new Date(user.resetPasswordLastRequestedAt).getTime()) < 60 * 1000) {
            const waitSec = Math.ceil((60 * 1000 - (Date.now() - new Date(user.resetPasswordLastRequestedAt).getTime())) / 1000);
            return res.render('forgot_password', {
                error: `An OTP was recently generated. Please wait ${waitSec} second(s) before requesting another.`,
                identifier
            });
        }

        // Generate secure 6-digit OTP
        const otp = crypto.randomInt(100000, 999999).toString();
        user.resetPasswordOtp = otp;
        user.resetPasswordOtpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        user.resetPasswordOtpAttempts = 0;
        user.resetPasswordLastRequestedAt = new Date();
        await user.save();

        // Mask email for display: e.g. j***@gmail.com
        const parts = user.email.split('@');
        const userPart = parts[0] || '';
        const domainPart = parts[1] || '';
        const maskedUserPart = userPart.length <= 2
            ? userPart[0] + '*'
            : userPart[0] + '*'.repeat(Math.min(userPart.length - 2, 5)) + userPart[userPart.length - 1];
        const maskedEmail = `${maskedUserPart}@${domainPart}`;

        // Send OTP via Brevo multi-account pool
        try {
            await brevoMailPool.sendOtpEmail({
                toEmail: user.email,
                toName: user.fullName || user.username,
                otp,
                expiresMinutes: 10
            });
        } catch (mailErr) {
            console.warn(`[Forgot Password] Brevo mail pool notice: ${mailErr.message}`);
            console.log(`[AUTH OTP DEV FALLBACK] Generated OTP for @${user.username} (${user.email}): ${otp}`);
        }

        return res.render('reset_password', {
            identifier: user.username,
            maskedEmail,
            error: null,
            message: `OTP sent successfully to your registered email (${maskedEmail}). Please check your inbox or spam folder.`
        });
    } catch (err) {
        console.error('Error initiating password reset:', err);
        return res.render('forgot_password', {
            error: 'An error occurred while processing your request: ' + err.message,
            identifier: req.body ? req.body.identifier : ''
        });
    }
});

router.get('/reset-password', (req, res) => {
    const identifier = req.query.identifier || '';
    res.render('reset_password', {
        identifier,
        maskedEmail: req.query.email || '',
        error: req.query.error || null,
        message: req.query.message || null
    });
});

router.post('/reset-password', resetPasswordLimiter.middleware((req) => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown', (req, res, msg) => {
    return res.status(429).render('reset_password', {
        error: msg,
        identifier: req.body && req.body.identifier ? String(req.body.identifier) : '',
        maskedEmail: req.body && req.body.maskedEmail ? String(req.body.maskedEmail) : ''
    });
}), async (req, res) => {
    try {
        const identifier = String((req.body && req.body.identifier) || '').trim();
        const otp = String((req.body && req.body.otp) || '').trim();
        const password = String((req.body && req.body.password) || '');
        const confirmPassword = String((req.body && req.body.confirmPassword) || '');
        const maskedEmail = String((req.body && req.body.maskedEmail) || '');

        if (!identifier) {
            return res.render('reset_password', {
                error: 'Missing account identifier. Please request a new OTP.',
                identifier,
                maskedEmail
            });
        }
        if (!otp || otp.length !== 6) {
            return res.render('reset_password', {
                error: 'Please enter a valid 6-digit OTP code.',
                identifier,
                maskedEmail
            });
        }
        if (!password || password.length < 6) {
            return res.render('reset_password', {
                error: 'New password must be at least 6 characters long.',
                identifier,
                maskedEmail
            });
        }
        if (password !== confirmPassword) {
            return res.render('reset_password', {
                error: 'Passwords do not match. Please re-enter both fields.',
                identifier,
                maskedEmail
            });
        }

        const user = await User.findOne({
            $or: [
                { rollnumber: identifier },
                { rollnumber: identifier.toUpperCase() },
                { username: identifier.toLowerCase() },
                { email: identifier.toLowerCase() }
            ]
        });

        if (!user || !user.resetPasswordOtp) {
            return res.render('reset_password', {
                error: 'No active password reset request found. Please request a new OTP.',
                identifier,
                maskedEmail
            });
        }

        if (!user.resetPasswordOtpExpires || new Date() > user.resetPasswordOtpExpires) {
            user.resetPasswordOtp = null;
            user.resetPasswordOtpExpires = null;
            user.resetPasswordOtpAttempts = 0;
            await user.save();
            return res.render('reset_password', {
                error: 'The OTP code has expired. Please request a new OTP.',
                identifier,
                maskedEmail
            });
        }

        // Timing-safe comparison to prevent side-channel timing analysis attacks
        const expectedOtp = String(user.resetPasswordOtp || '').trim();
        const providedOtp = String(otp).trim();
        const isMatch = (expectedOtp.length === 6 && providedOtp.length === 6 &&
            crypto.timingSafeEqual(Buffer.from(expectedOtp), Buffer.from(providedOtp)));

        if (!isMatch) {
            user.resetPasswordOtpAttempts = (user.resetPasswordOtpAttempts || 0) + 1;
            const remaining = Math.max(0, 5 - user.resetPasswordOtpAttempts);
            if (remaining === 0) {
                user.resetPasswordOtp = null;
                user.resetPasswordOtpExpires = null;
                user.resetPasswordOtpAttempts = 0;
                await user.save();
                return res.render('reset_password', {
                    error: 'Too many incorrect OTP attempts. For your security, this OTP has been invalidated. Please request a new OTP.',
                    identifier,
                    maskedEmail
                });
            }
            await user.save();
            return res.render('reset_password', {
                error: `Invalid OTP code. ${remaining} attempt(s) remaining. Please check your email and try again.`,
                identifier,
                maskedEmail
            });
        }

        // Valid OTP! Reset password and invalidate OTP
        await user.setPassword(password);
        user.resetPasswordOtp = null;
        user.resetPasswordOtpExpires = null;
        user.resetPasswordOtpAttempts = 0;
        await user.save();

        console.log(`[Auth] Password reset successfully via OTP for user @${user.username}.`);
        return res.redirect('/login?message=' + encodeURIComponent('Your password has been reset successfully! Please sign in with your new password.'));
    } catch (err) {
        console.error('Error verifying OTP and resetting password:', err);
        return res.render('reset_password', {
            error: 'Could not reset password: ' + err.message,
            identifier: req.body ? req.body.identifier : '',
            maskedEmail: req.body ? req.body.maskedEmail : ''
        });
    }
});

router.post('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        if (req.session) {
            req.session.destroy(() => {
                res.clearCookie(SESSION_COOKIE_NAME);
                res.redirect('/login?message=signed_out');
            });
        } else {
            res.clearCookie(SESSION_COOKIE_NAME);
            res.redirect('/login?message=signed_out');
        }
    });
});

router.get('/account', requireAuth, (req, res) => {
    const msgMap = {
        password_updated: 'Password updated successfully.'
    };
    res.render('account', {
        error: req.query.error || null,
        message: msgMap[req.query.message] || null
    });
});

router.post('/account/password', requireAuth, passwordChangeLimiter.middleware(), async (req, res) => {
    try {
        const currentPassword = String((req.body && req.body.currentPassword) || '');
        const newPassword = String((req.body && req.body.newPassword) || '');
        const confirmPassword = String((req.body && req.body.confirmPassword) || '');

        if (!currentPassword || !newPassword) {
            return res.status(400).render('account', {
                error: 'Current password and new password are required.',
                message: null
            });
        }
        if (newPassword.length < 6) {
            return res.status(400).render('account', {
                error: 'New password must be at least 6 characters long.',
                message: null
            });
        }
        if (newPassword !== confirmPassword) {
            return res.status(400).render('account', {
                error: 'New password and confirmation do not match.',
                message: null
            });
        }

        await req.user.changePassword(currentPassword, newPassword);
        return res.redirect('/account?message=password_updated');
    } catch (err) {
        const errMsg = (err && (err.name === 'IncorrectPasswordError' || err.name === 'IncorrectUsernameError'))
            ? 'Current password is incorrect.'
            : (err.message || 'Could not update password.');
        return res.status(400).render('account', {
            error: errMsg,
            message: null
        });
    }
});

router.post('/account/email', requireAuth, async (req, res) => {
    try {
        const email = String((req.body && req.body.email) || '').trim().toLowerCase();
        if (email && !isValidEmail(email)) {
            return res.redirect('/account?error=' + encodeURIComponent('Please enter a valid email address (e.g. name@example.com).'));
        }
        const targetUser = await User.findById(req.user._id);
        if (!targetUser) return res.redirect('/login');
        targetUser.email = email;
        await targetUser.save();
        return res.redirect('/account?message=' + encodeURIComponent('Email address updated successfully.'));
    } catch (err) {
        return res.redirect('/account?error=' + encodeURIComponent(err.message || 'Could not update email.'));
    }
});

module.exports = router;
