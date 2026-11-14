const dns = require('dns');
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const Paper = require('./models/Paper');
const Submission = require('./models/Submission');
const Result = Submission;
const User = require('./models/User');
const { uploadOmrSheet, deleteOmrSheet } = require('./utils/cloudinaryPool');
const {
    parseBulkStudentsInput,
    annotateExistingUsers,
    generateStudentPassword,
    extractFirst3
} = require('./utils/bulkStudents');
const { summarizeSections, buildDetailedResultsCsv } = require('./utils/resultsExport');
const {
    loginLimiter,
    apiLimiter,
    passwordChangeLimiter,
    securityHeaders,
    sanitizeMongo,
    csrfProtection,
    secureImageUpload,
    secureSpreadsheetUpload,
    isValidId,
    isValidMongoId,
    uploadDir
} = require('./utils/security');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();

// Disable information disclosure & enable reverse proxy trust
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = process.env.PORT || (process.env.RENDER ? 10000 : 3000);
const SESSION_COOKIE_NAME = 'garud.sid';

// Ensure upload directory exists
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Seed default admin account when no admins exist yet
async function ensureDefaultAdmin() {
    try {
        const adminCount = await User.countDocuments({ role: 'admin' });
        if (adminCount === 0) {
            const defaultUsername = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
            const defaultPassword = process.env.ADMIN_PASSWORD || 'admin123';
            const existing = await User.findOne({ username: defaultUsername });
            if (existing) {
                existing.role = 'admin';
                await existing.setPassword(defaultPassword);
                await existing.save();
                console.log(`[Auth] Promoted existing account "${defaultUsername}" to default Admin.`);
            } else {
                await User.register(
                    new User({
                        username: defaultUsername,
                        fullName: 'Administrator',
                        role: 'admin',
                        rollnumber: ''
                    }),
                    defaultPassword
                );
                console.log(`[Auth] Seeded default Admin account "${defaultUsername}".`);
            }
            if (defaultPassword === 'admin123') {
                console.warn('\x1b[33m%s\x1b[0m', '[SECURITY WARNING] Default admin password "admin123" is in use! Please change it in /account.');
            }
        }
    } catch (err) {
        console.error('[Auth] Error seeding default admin:', err.message);
    }
}

// Setup mongoose connection & MongoDB-backed session store
const mongoConnectPromise = mongoose.connect(process.env.MONGO_URL);
const sessionStore = MongoStore.create({
    clientPromise: mongoConnectPromise.then(m => m.connection.getClient()),
    collectionName: 'sessions',
    ttl: 7 * 24 * 60 * 60
});

mongoConnectPromise
    .then(async () => {
        console.log('Connected to MongoDB');
        await ensureDefaultAdmin();
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`[Security Hardened] Server running on http://0.0.0.0:${PORT} (PORT=${PORT})`);
        });
    })
    .catch(err => console.error('MongoDB connection error:', err));

// Public Cloud Uptime & Health Check Endpoints (Bypasses auth/session)
app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// Global Security Headers (CSP, FrameGuard, NoSniff, ReferrerPolicy, PermissionsPolicy)
app.use(securityHeaders);

// NoSQL Operator & Prototype Injection Sanitizer
app.use(sanitizeMongo);

// Cross-Site Request Forgery (CSRF) Origin/Referer Guard
app.use(csrfProtection);

// API Route Rate Limiting (Protects backend endpoints from abuse & scraping)
app.use('/api', apiLimiter.middleware());

// View engine & body parsers
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.json({ limit: '25mb' }));

// Public stylesheets (needed for login page)
app.use('/css', express.static(path.join(__dirname, 'public/css')));

// Session & Passport configuration (Hardened cookies & session store)
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
const sessionSecret = process.env.SESSION_SECRET ||
    crypto.createHash('sha256').update(process.env.MONGO_URL || 'garud-omr-session-secret').digest('hex');

app.use(session({
    name: SESSION_COOKIE_NAME,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.use(new LocalStrategy(User.authenticate()));
passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());

app.use((req, res, next) => {
    res.locals.currentUser = req.user || null;
    next();
});

// Auth & RBAC Helpers
function isApiRequest(req) {
    if (req.originalUrl && req.originalUrl.startsWith('/api/')) return true;
    const accept = req.headers.accept || '';
    return Boolean(req.xhr || req.is('application/json') || (accept.includes('application/json') && !accept.includes('text/html')));
}

function getSafeReturnTo(rawUrl) {
    if (typeof rawUrl !== 'string') return null;
    const trimmed = rawUrl.trim();
    if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) return null;
    if (trimmed.startsWith('/login') || trimmed.startsWith('/logout') || trimmed.startsWith('/api/')) return null;
    return trimmed;
}

function requireAuth(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated() && req.user) {
        return next();
    }
    if (isApiRequest(req)) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.method === 'GET' && req.session) {
        const candidate = getSafeReturnTo(req.originalUrl);
        if (candidate) {
            req.session.returnTo = candidate;
        }
    }
    return res.redirect('/login');
}

function requireAdmin(req, res, next) {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
        if (isApiRequest(req)) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        if (req.method === 'GET' && req.session) {
            const candidate = getSafeReturnTo(req.originalUrl);
            if (candidate) {
                req.session.returnTo = candidate;
            }
        }
        return res.redirect('/login');
    }
    if (req.user.role !== 'admin') {
        if (isApiRequest(req)) {
            return res.status(403).json({ error: 'Administrator access required' });
        }
        return res.status(403).render('forbidden');
    }
    return next();
}

// Protect uploaded/fallback OMR copies (students can only read fallback copies tied to their own roll)
app.use('/uploads', requireAuth, (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:;");

    // Path traversal defense
    const requestedPath = path.normalize(req.path);
    const fullPath = path.join(uploadDir, requestedPath);
    if (!fullPath.startsWith(uploadDir)) {
        return res.status(403).send('Forbidden: Path Traversal Detected');
    }

    if (req.user.role === 'admin') return next();
    const roll = String(req.user.rollnumber || req.user.username || '').trim().replace(/[^\w-]/g, '_');
    const basename = path.basename(req.path || '');
    if (roll && basename.toLowerCase().includes(roll.toLowerCase())) {
        return next();
    }
    return res.status(403).send('Forbidden');
}, express.static(uploadDir, { dotfiles: 'ignore', index: false }));

const upload = secureImageUpload;

// Helper to convert answer key to object (with XSS script-breakout neutralization)
function getAnswerKeyJson(paper) {
    if (!paper) return '{}';
    const obj = {};
    if (Array.isArray(paper.answer_key) && paper.answer_key.length > 0) {
        paper.answer_key.forEach((val, idx) => {
            if (val) obj[String(idx + 1)] = val;
        });
        return JSON.stringify(obj).replace(/</g, '\\u003c');
    }
    if (paper.answerKey instanceof Map) {
        return JSON.stringify(Object.fromEntries(paper.answerKey)).replace(/</g, '\\u003c');
    }
    if (typeof paper.answerKey === 'object' && paper.answerKey !== null) {
        if (typeof paper.answerKey.toObject === 'function') {
            return JSON.stringify(paper.answerKey.toObject()).replace(/</g, '\\u003c');
        }
        return JSON.stringify(paper.answerKey).replace(/</g, '\\u003c');
    }
    return '{}';
}

// Helper to build 1-based answer key lookup map
function buildKeyLookup(paper) {
    const keyLookup = {};
    if (!paper) return keyLookup;
    const totalQ = paper.total_questions || paper.numQuestions || 50;
    if (Array.isArray(paper.answer_key) && paper.answer_key.length > 0) {
        paper.answer_key.forEach((ans, i) => {
            if (ans && typeof ans === 'string' && ans.trim() !== '') {
                keyLookup[i + 1] = ans.trim().toUpperCase();
            }
        });
    } else if (paper.answerKey) {
        for (let i = 1; i <= totalQ; i++) {
            const k = (typeof paper.answerKey.get === 'function')
                ? paper.answerKey.get(String(i))
                : paper.answerKey[String(i)];
            if (k && typeof k === 'string' && k.trim() !== '') {
                keyLookup[i] = k.trim().toUpperCase();
            }
        }
    }
    return keyLookup;
}

// Re-evaluate a student's saved responses array against a keyLookup
function evaluateResponsesAgainstKey(responses, keyLookup, totalQ) {
    const resps = Array.isArray(responses) ? responses : [];
    let score = 0;
    let correctCount = 0;
    let wrongCount = 0;
    let blankCount = 0;
    let evaluatedKeyCount = 0;

    for (let q = 1; q <= totalQ; q++) {
        const raw = resps[q - 1];
        const marked = raw ? String(raw).trim().toUpperCase() : '';
        const key = keyLookup[q] ? String(keyLookup[q]).trim().toUpperCase() : '';

        if (key) evaluatedKeyCount++;

        if (!marked) {
            blankCount++;
        } else if (marked.includes(',')) {
            // Multiple bubbles shaded -> treated as wrong/invalid
            wrongCount++;
        } else if (key && marked === key) {
            score++;
            correctCount++;
        } else if (key) {
            wrongCount++;
        }
    }

    const denom = evaluatedKeyCount > 0 ? evaluatedKeyCount : totalQ;
    const percentage = denom > 0 ? Math.round((score / denom) * 100) : 0;

    return { score, correctCount, wrongCount, blankCount, percentage };
}

// Recalculate and persist scores for all existing submissions of a paper
async function regradePaperSubmissions(paper) {
    if (!paper) return 0;
    const paperIdStr = String(paper._id);
    const submissions = await Submission.find({
        $or: [
            { paper_id: paperIdStr },
            { paper_id: paper._id },
            { paperId: paper._id }
        ]
    });

    if (!submissions || submissions.length === 0) return 0;

    const keyLookup = buildKeyLookup(paper);
    const defaultTotalQ = paper.total_questions || paper.numQuestions || 50;
    const paperMaxMarks = paper.max_marks || (defaultTotalQ * 4);

    const bulkOps = submissions
        .filter(sub => sub.examType !== 'jee')
        .map(sub => {
        const totalQ = sub.totalQuestions || defaultTotalQ;
        const graded = evaluateResponsesAgainstKey(sub.responses, keyLookup, totalQ);

        return {
            updateOne: {
                filter: { _id: sub._id },
                update: {
                    $set: {
                        score: graded.score,
                        totalQuestions: totalQ,
                        percentage: graded.percentage,
                        maxMarks: paperMaxMarks,
                        correctCount: graded.correctCount,
                        wrongCount: graded.wrongCount,
                        blankCount: graded.blankCount
                    }
                }
            }
        };
    });

    if (bulkOps.length > 0) {
        await Submission.bulkWrite(bulkOps);
    }

    console.log(`[Recheck] Regraded ${submissions.length} submission(s) for paper "${paperIdStr}"`);
    return submissions.length;
}

// Authentication Routes (passport-local + passport-local-mongoose)
app.get('/login', (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated() && req.user) {
        return res.redirect(req.user.role === 'admin' ? '/' : '/student');
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

app.post('/login', loginLimiter.middleware((req) => {
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
                const dest = user.role === 'admin' ? (savedReturnTo || '/') : '/student';
                return res.redirect(dest);
            });
        });
    })(req, res, next);
});

// Registration is disabled (accounts are created by Admins in /users)
app.get('/register', (req, res) => {
    res.redirect('/login');
});

app.post('/logout', (req, res, next) => {
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

app.get('/account', requireAuth, (req, res) => {
    const msgMap = {
        password_updated: 'Password updated successfully.'
    };
    res.render('account', {
        error: req.query.error || null,
        message: msgMap[req.query.message] || null
    });
});

app.post('/account/password', requireAuth, passwordChangeLimiter.middleware(), async (req, res) => {
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

// Admin User Management Routes
app.get('/users', requireAdmin, async (req, res) => {
    try {
        const users = await User.find().sort({ role: 1, createdAt: -1 });
        const bulkReport = (req.session && req.session.bulkImportReport) ? req.session.bulkImportReport : null;
        if (req.session && req.session.bulkImportReport) {
            delete req.session.bulkImportReport;
        }
        res.render('users', {
            users,
            error: req.query.error || null,
            message: req.query.message || null,
            bulkReport
        });
    } catch (err) {
        res.status(500).send('Error loading users: ' + err.message);
    }
});

// Download sample CSV template for bulk student import
app.get('/users/bulk-template', requireAdmin, (req, res) => {
    const csv = [
        'roll_number,name,fathers_name,mothers_name',
        '01234567,Aarav Sharma,Rajesh Sharma,Sunita Sharma',
        '01234568,Priya Verma,Vikram Verma,Meena Verma'
    ].join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="students_bulk_template.csv"');
    res.send(csv);
});

function handleBulkUploadMiddleware(req, res, next) {
    secureSpreadsheetUpload.single('studentFile')(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Uploaded file exceeds the 5 MB limit.' : (err.message || 'Upload failed.');
            if (isApiRequest(req) || (req.originalUrl && req.originalUrl.startsWith('/users/bulk/parse'))) {
                return res.status(400).json({ error: msg });
            }
            return res.redirect('/users?error=' + encodeURIComponent(msg));
        }
        next();
    });
}

// Preview & validate uploaded spreadsheet or pasted rows before creating accounts
app.post('/users/bulk/parse', requireAdmin, handleBulkUploadMiddleware, async (req, res) => {
    try {
        const rawText = req.body ? req.body.rawText : '';
        const parsedRows = await parseBulkStudentsInput({ file: req.file || null, rawText });
        const annotated = await annotateExistingUsers(parsedRows, User);

        const readyCount = annotated.filter(r => r.status === 'ready').length;
        const existsCount = annotated.filter(r => r.status === 'exists' || r.status === 'duplicate_in_file').length;
        const invalidCount = annotated.filter(r => r.status === 'invalid').length;

        res.json({
            success: true,
            rows: annotated,
            summary: {
                total: annotated.length,
                readyCount,
                existsCount,
                invalidCount
            }
        });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Could not parse spreadsheet.' });
    }
});

// Bulk create student accounts (only name and rollnumber stored in DB; password derived from name + father + mother)
app.post('/users/bulk', requireAdmin, handleBulkUploadMiddleware, async (req, res) => {
    try {
        let candidateRows = [];

        if (req.body && Array.isArray(req.body.students)) {
            const seen = new Set();
            candidateRows = req.body.students.map((item, idx) => {
                const rollnumber = String((item && item.rollnumber) || '').trim();
                const name = String((item && item.name) || '').trim();
                const fatherName = String((item && item.fatherName) || '').trim();
                const motherName = String((item && item.motherName) || '').trim();
                const username = rollnumber.toLowerCase().replace(/\s+/g, '');
                const generatedPassword = generateStudentPassword(name, fatherName, motherName);

                let status = 'ready';
                let reason = '';
                if (!rollnumber) {
                    status = 'invalid';
                    reason = 'Roll number is required';
                } else if (!/^[a-z0-9._-]{2,40}$/.test(username)) {
                    status = 'invalid';
                    reason = 'Roll number must be 2-40 characters (letters, digits, ., _, -)';
                } else if (!name || extractFirst3(name).length === 0) {
                    status = 'invalid';
                    reason = 'Student name must contain letters';
                } else if (!fatherName || extractFirst3(fatherName).length === 0) {
                    status = 'invalid';
                    reason = "Father's name must contain letters";
                } else if (!motherName || extractFirst3(motherName).length === 0) {
                    status = 'invalid';
                    reason = "Mother's name must contain letters";
                } else if (seen.has(username)) {
                    status = 'duplicate_in_file';
                    reason = 'Duplicate roll number in upload';
                } else {
                    seen.add(username);
                }

                return {
                    rowNumber: Number(item && item.rowNumber) || (idx + 1),
                    rollnumber,
                    username,
                    name,
                    generatedPassword,
                    status,
                    reason
                };
            });
        } else {
            const rawText = req.body ? req.body.rawText : '';
            candidateRows = await parseBulkStudentsInput({ file: req.file || null, rawText });
        }

        const annotated = await annotateExistingUsers(candidateRows, User);

        const created = [];
        const skipped = [];
        const failed = [];
        const readyToCreate = [];

        annotated.forEach(row => {
            if (row.status === 'ready') {
                readyToCreate.push(row);
            } else if (row.status === 'exists' || row.status === 'duplicate_in_file') {
                skipped.push({
                    rowNumber: row.rowNumber,
                    rollnumber: row.rollnumber,
                    name: row.name,
                    reason: row.reason
                });
            } else {
                failed.push({
                    rowNumber: row.rowNumber,
                    rollnumber: row.rollnumber,
                    name: row.name,
                    reason: row.reason || 'Invalid row'
                });
            }
        });

        // Register validated students in small batches (storing only username, fullName, role, rollnumber + password hash)
        const BATCH_SIZE = 4;
        for (let i = 0; i < readyToCreate.length; i += BATCH_SIZE) {
            const batch = readyToCreate.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async row => {
                try {
                    const userDoc = new User({
                        username: row.username,
                        fullName: row.name,
                        role: 'student',
                        rollnumber: row.rollnumber
                    });
                    await User.register(userDoc, row.generatedPassword);
                    created.push({
                        _id: String(userDoc._id),
                        rowNumber: row.rowNumber,
                        rollnumber: userDoc.rollnumber,
                        name: userDoc.fullName,
                        username: userDoc.username
                    });
                } catch (regErr) {
                    if (regErr && (regErr.name === 'UserExistsError' || regErr.code === 11000)) {
                        skipped.push({
                            rowNumber: row.rowNumber,
                            rollnumber: row.rollnumber,
                            name: row.name,
                            reason: 'Account already exists (skipped)'
                        });
                    } else {
                        failed.push({
                            rowNumber: row.rowNumber,
                            rollnumber: row.rollnumber,
                            name: row.name,
                            reason: (regErr && regErr.message) || 'Failed to create account'
                        });
                    }
                }
            }));
        }

        const summary = {
            total: annotated.length,
            createdCount: created.length,
            skippedCount: skipped.length,
            failedCount: failed.length
        };

        if (isApiRequest(req)) {
            return res.json({ success: true, summary, created, skipped, failed });
        }

        if (req.session) {
            req.session.bulkImportReport = { summary, skipped: skipped.slice(0, 50), failed: failed.slice(0, 50) };
        }
        return res.redirect('/users?message=' + encodeURIComponent(
            `Bulk import finished: ${summary.createdCount} created, ${summary.skippedCount} skipped, ${summary.failedCount} failed.`
        ));
    } catch (err) {
        if (isApiRequest(req)) {
            return res.status(400).json({ error: err.message || 'Bulk upload failed.' });
        }
        return res.redirect('/users?error=' + encodeURIComponent(err.message || 'Bulk upload failed.'));
    }
});

app.post('/users', requireAdmin, async (req, res) => {
    try {
        const role = req.body.role === 'admin' ? 'admin' : 'student';
        const username = String(req.body.username || '').trim().toLowerCase();
        const fullName = String(req.body.fullName || '').trim();
        const rollnumber = role === 'student' ? String(req.body.rollnumber || '').trim() : '';
        const password = String(req.body.password || '');

        if (!username || !/^[a-z0-9._-]{2,40}$/.test(username)) {
            return res.redirect('/users?error=' + encodeURIComponent('Username must be 2-40 characters using lowercase letters, numbers, dots, underscores, or hyphens.'));
        }
        if (role === 'student' && !rollnumber) {
            return res.redirect('/users?error=' + encodeURIComponent('Student roll number is required for student accounts.'));
        }
        if (password.length < 6) {
            return res.redirect('/users?error=' + encodeURIComponent('Password must be at least 6 characters long.'));
        }

        const newUser = new User({
            username,
            fullName,
            role,
            rollnumber
        });
        await User.register(newUser, password);
        return res.redirect('/users?message=' + encodeURIComponent(`Account @${username} (${role}) created successfully.`));
    } catch (err) {
        return res.redirect('/users?error=' + encodeURIComponent(err.message || 'Could not create user.'));
    }
});

app.post('/users/:id/password', requireAdmin, passwordChangeLimiter.middleware(), async (req, res) => {
    try {
        if (!isValidMongoId(req.params.id)) {
            return res.redirect('/users?error=' + encodeURIComponent('Invalid user identifier.'));
        }
        const password = String((req.body && req.body.password) || '');
        if (password.length < 6) {
            return res.redirect('/users?error=' + encodeURIComponent('Password must be at least 6 characters long.'));
        }
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) {
            return res.redirect('/users?error=' + encodeURIComponent('User not found.'));
        }
        await targetUser.setPassword(password);
        await targetUser.save();
        return res.redirect('/users?message=' + encodeURIComponent(`Password updated for @${targetUser.username}.`));
    } catch (err) {
        return res.redirect('/users?error=' + encodeURIComponent(err.message || 'Could not update password.'));
    }
});

app.post('/users/:id/delete', requireAdmin, async (req, res) => {
    try {
        if (!isValidMongoId(req.params.id)) {
            return res.redirect('/users?error=' + encodeURIComponent('Invalid user identifier.'));
        }
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) {
            return res.redirect('/users?error=' + encodeURIComponent('User not found.'));
        }
        if (String(targetUser._id) === String(req.user._id)) {
            return res.redirect('/users?error=' + encodeURIComponent('You cannot delete your own signed-in account.'));
        }
        if (targetUser.role === 'admin') {
            const adminCount = await User.countDocuments({ role: 'admin' });
            if (adminCount <= 1) {
                return res.redirect('/users?error=' + encodeURIComponent('Cannot delete the last remaining Admin account.'));
            }
        }
        await User.findByIdAndDelete(targetUser._id);
        return res.redirect('/users?message=' + encodeURIComponent(`Account @${targetUser.username} deleted.`));
    } catch (err) {
        return res.redirect('/users?error=' + encodeURIComponent(err.message || 'Could not delete user.'));
    }
});

// Dashboard & Paper Routes
app.get('/', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.redirect('/student');
    }
    try {
        const papers = await Paper.find().sort({ createdAt: -1 });
        res.render('index', { papers });
    } catch (e) {
        res.status(500).send('Error loading papers: ' + e.message);
    }
});

app.get('/paper/new', requireAdmin, (req, res) => {
    res.render('create_paper');
});

app.post('/paper/new', requireAdmin, async (req, res) => {
    try {
        const {
            paper_id,
            id,
            title,
            subject,
            total_questions,
            numQuestions,
            max_marks,
            sections,
            answer_key
        } = req.body;

        const totalQ = Number(total_questions || numQuestions) || 50;
        const maxM = Number(max_marks) || (totalQ * 4);

        let parsedSections = [];
        if (typeof sections === 'string' && sections.trim() !== '') {
            try {
                parsedSections = JSON.parse(sections);
            } catch (e) {
                console.warn('Invalid sections JSON:', e.message);
            }
        } else if (Array.isArray(sections)) {
            parsedSections = sections;
        }

        let parsedAnswerKey = [];
        if (typeof answer_key === 'string' && answer_key.trim() !== '') {
            try {
                parsedAnswerKey = JSON.parse(answer_key);
            } catch (e) {
                console.warn('Invalid answer_key JSON:', e.message);
            }
        } else if (Array.isArray(answer_key)) {
            parsedAnswerKey = answer_key;
        }

        const paperData = {
            title: title ? title.trim() : 'Untitled Paper',
            subject: subject ? subject.trim() : 'General',
            total_questions: totalQ,
            max_marks: maxM,
            sections: parsedSections,
            answer_key: parsedAnswerKey
        };

        const customId = (paper_id || id || '').trim();
        if (customId) {
            paperData._id = customId;
        }

        const newPaper = new Paper(paperData);
        await newPaper.save();
        res.redirect(`/paper/${newPaper._id}`);
    } catch (error) {
        console.error('Error creating paper:', error);
        res.status(500).send('Error creating paper: ' + error.message);
    }
});

// Resource ID Sanitizer (Protects against IDOR/injection via path parameters)
app.param('id', (req, res, next, id) => {
    if (!isValidId(id)) {
        if (isApiRequest(req)) {
            return res.status(400).json({ error: 'Invalid resource identifier format.' });
        }
        return res.status(400).render('error', { message: 'Invalid resource identifier format.' });
    }
    next();
});

app.get('/paper/:id', requireAdmin, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id) || await Paper.findOne({ _id: decodeURIComponent(req.params.id) });
        if (!paper) return res.status(404).send('Paper not found');
        res.render('paper_detail', { paper });
    } catch (error) {
        res.status(500).send('Error loading paper: ' + error.message);
    }
});

// Dedicated JEE Mains Answer Key Page (Shows only Q1-20, Q41-60, Q81-100 divided into 3 sections)
app.get('/paper/:id/jee-answerkey', requireAdmin, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id) || await Paper.findOne({ _id: decodeURIComponent(req.params.id) });
        if (!paper) return res.status(404).send('Paper not found');
        res.render('jee_answerkey', { paper, saved: req.query.saved === 'true' });
    } catch (error) {
        res.status(500).send('Error loading JEE answer key: ' + error.message);
    }
});

// Save JEE Mains Answer Key
app.post('/paper/:id/jee-answerkey', requireAdmin, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) return res.status(404).send('Paper not found');

        const currentTotal = paper.total_questions || paper.numQuestions || 50;
        const newTotalQ = Math.max(100, currentTotal);
        paper.total_questions = newTotalQ;

        // Clone or create array with enough length for Q1-100
        const answerKeyArr = new Array(newTotalQ).fill(null);
        if (Array.isArray(paper.answer_key)) {
            for (let i = 0; i < paper.answer_key.length && i < newTotalQ; i++) {
                answerKeyArr[i] = paper.answer_key[i];
            }
        }

        // Section 1: Physics Q1-20
        for (let i = 1; i <= 20; i++) {
            const val = req.body[`q${i}`];
            answerKeyArr[i - 1] = (val && typeof val === 'string' && val.trim() !== '') ? val.trim().toUpperCase() : null;
        }

        // Section 2: Chemistry Q41-60
        for (let i = 41; i <= 60; i++) {
            const val = req.body[`q${i}`];
            answerKeyArr[i - 1] = (val && typeof val === 'string' && val.trim() !== '') ? val.trim().toUpperCase() : null;
        }

        // Section 3: Mathematics Q81-100
        for (let i = 81; i <= 100; i++) {
            const val = req.body[`q${i}`];
            answerKeyArr[i - 1] = (val && typeof val === 'string' && val.trim() !== '') ? val.trim().toUpperCase() : null;
        }

        paper.answer_key = answerKeyArr;
        await paper.save();

        // Automatically recheck all previously scanned OMR submissions against the updated key
        await regradePaperSubmissions(paper);

        res.redirect(`/paper/${encodeURIComponent(paper._id)}/jee-answerkey?saved=true`);
    } catch (error) {
        console.error('Error saving JEE answer key:', error);
        res.status(500).send('Error saving JEE answer key: ' + error.message);
    }
});

app.get('/paper/:id/omr', requireAdmin, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id);
        if (!paper) return res.status(404).send('Paper not found');
        res.render('omr_sheet', { paper });
    } catch (error) {
        res.status(500).send('Error loading OMR sheet: ' + error.message);
    }
});

app.post('/paper/:id/answerkey', requireAdmin, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) return res.status(404).send('Paper not found');

        const totalQ = paper.total_questions || paper.numQuestions || 50;
        const answerKeyArr = new Array(totalQ).fill(null);

        for (let i = 1; i <= totalQ; i++) {
            const val = req.body[`q${i}`];
            if (val && typeof val === 'string' && val.trim() !== '') {
                answerKeyArr[i - 1] = val.trim().toUpperCase();
            } else {
                answerKeyArr[i - 1] = null;
            }
        }

        paper.answer_key = answerKeyArr;
        await paper.save();

        // Automatically recheck all previously scanned OMR submissions against the updated key
        await regradePaperSubmissions(paper);

        res.redirect(`/paper/${encodeURIComponent(paper._id)}`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error saving answer key: ' + error.message);
    }
});

// Explicit API endpoint to recheck/regrade all OMR submissions for a paper against its current answer key
app.post('/api/paper/:id/recheck', requireAdmin, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) return res.status(404).json({ error: 'Paper not found' });

        const recheckedCount = await regradePaperSubmissions(paper);
        res.json({ success: true, recheckedCount });
    } catch (error) {
        console.error('Error rechecking submissions:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update or configure sections for a paper
app.post('/paper/:id/sections', requireAdmin, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id);
        if (!paper) return res.status(404).json({ error: 'Paper not found' });

        let parsedSections = [];
        const raw = req.body.sections;
        if (typeof raw === 'string') {
            parsedSections = JSON.parse(raw);
        } else if (Array.isArray(raw)) {
            parsedSections = raw;
        }

        paper.sections = parsedSections;
        await paper.save();

        res.json({ success: true, sections: paper.sections });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/paper/:id/scan', requireAdmin, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id);
        if (!paper) return res.status(404).send('Paper not found');
        res.render('scanner', { paper, answerKey: getAnswerKeyJson(paper) });
    } catch (error) {
        res.status(500).send('Error loading scanner: ' + error.message);
    }
});

app.post('/paper/:id/check', requireAdmin, upload.single('omrSheet'), async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id);
        if (!paper) return res.status(404).send('Paper not found');

        if (!req.file) {
            return res.status(400).send('No file selected. Please go back and upload an image file.');
        }

        res.render('evaluator', {
            paper,
            imagePath: '/uploads/' + req.file.filename,
            answerKey: getAnswerKeyJson(paper)
        });
    } catch (error) {
        console.error('Evaluation upload error:', error);
        res.status(500).send('Error processing upload: ' + error.message);
    }
});

// JEE Mains Live Camera Scanner (Q1-20, Q41-60, Q81-100 + Section B Numerical)
app.get('/paper/:id/jee-scan', requireAdmin, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id) || await Paper.findOne({ _id: decodeURIComponent(req.params.id) });
        if (!paper) return res.status(404).send('Paper not found');
        res.render('jee_scanner', { paper, answerKey: getAnswerKeyJson(paper) });
    } catch (error) {
        res.status(500).send('Error loading JEE scanner: ' + error.message);
    }
});

// JEE Mains Manual/File Sheet Evaluator
app.get('/paper/:id/jee-evaluator', requireAdmin, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id) || await Paper.findOne({ _id: decodeURIComponent(req.params.id) });
        if (!paper) return res.status(404).send('Paper not found');
        res.render('jee_evaluator', {
            paper,
            imagePath: '',
            answerKey: getAnswerKeyJson(paper)
        });
    } catch (error) {
        res.status(500).send('Error loading JEE evaluator: ' + error.message);
    }
});

// JEE Mains Image Upload Evaluator
app.post('/paper/:id/jee-check', requireAdmin, secureImageUpload.single('omrSheet'), async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id) || await Paper.findOne({ _id: decodeURIComponent(req.params.id) });
        if (!paper) return res.status(404).send('Paper not found');

        if (!req.file) {
            return res.status(400).send('No file selected. Please go back and upload an image file.');
        }

        res.render('jee_evaluator', {
            paper,
            imagePath: '/uploads/' + req.file.filename,
            answerKey: getAnswerKeyJson(paper)
        });
    } catch (error) {
        console.error('JEE Evaluation upload error:', error);
        res.status(500).send('Error processing JEE upload: ' + error.message);
    }
});

// Helper to compute section-wise marks and total aggregate marks
function computeSectionWise(breakdown, totalQuestions, customSections = null) {
    let sectionDefs = [];
    if (Array.isArray(customSections) && customSections.length > 0) {
        sectionDefs = customSections.map(s => {
            const start = Number(s.from_question);
            const end = Number(s.to_question);
            const countInSec = (end >= start) ? (end - start + 1) : 1;
            const maxM = Number(s.max_marks) || (countInSec * 4);
            return {
                name: s.name,
                start: start,
                end: end,
                maxMarks: maxM
            };
        });
    } else if (totalQuestions <= 30) {
        sectionDefs = [{ name: 'Section A (General)', start: 1, end: totalQuestions }];
    } else if (totalQuestions <= 60) {
        const half = Math.ceil(totalQuestions / 2);
        sectionDefs = [
            { name: 'Section A', start: 1, end: half },
            { name: 'Section B', start: half + 1, end: totalQuestions }
        ];
    } else if (totalQuestions <= 120) {
        const qPerSec = Math.ceil(totalQuestions / 4);
        sectionDefs = [
            { name: 'Section 1 (Physics)', start: 1, end: qPerSec },
            { name: 'Section 2 (Chemistry)', start: qPerSec + 1, end: qPerSec * 2 },
            { name: 'Section 3 (Mathematics)', start: (qPerSec * 2) + 1, end: qPerSec * 3 },
            { name: 'Section 4 (General)', start: (qPerSec * 3) + 1, end: totalQuestions }
        ];
    } else {
        const qPerSec = Math.ceil(totalQuestions / 4);
        sectionDefs = [
            { name: 'Physics', start: 1, end: qPerSec },
            { name: 'Chemistry', start: qPerSec + 1, end: qPerSec * 2 },
            { name: 'Botany / Math', start: (qPerSec * 2) + 1, end: qPerSec * 3 },
            { name: 'Zoology / Aptitude', start: (qPerSec * 3) + 1, end: totalQuestions }
        ];
    }

    const breakdownMap = {};
    if (Array.isArray(breakdown)) {
        breakdown.forEach(item => {
            if (item && item.q) breakdownMap[item.q] = item.verdict;
        });
    }

    let totalAggregateMarks = 0;
    let totalMaxMarks = 0;

    const sections = sectionDefs.map(sec => {
        let correct = 0;
        let wrong = 0;
        let multiple = 0;
        let blank = 0;
        const countInSec = (sec.end - sec.start) + 1;

        for (let q = sec.start; q <= sec.end; q++) {
            const v = breakdownMap[q];
            if (v === 'correct') correct++;
            else if (v === 'wrong') wrong++;
            else if (v === 'multiple') multiple++;
            else blank++;
        }

        const marks = (correct * 4) - (wrong * 1) - (multiple * 1);
        const maxMarks = sec.maxMarks || (countInSec * 4);

        totalAggregateMarks += marks;
        totalMaxMarks += maxMarks;

        return {
            sectionName: sec.name,
            range: `Q${sec.start}-Q${sec.end}`,
            correct,
            wrong,
            multiple,
            blank,
            marks: Math.max(0, marks),
            maxMarks
        };
    });

    return {
        sectionWise: sections,
        aggregateMarks: Math.max(0, totalAggregateMarks),
        maxMarks: totalMaxMarks
    };
}

// Shared helper to resolve section definitions for a paper
function getPaperSectionsDef(paper, fallbackTotalQ = 50) {
    if (paper && Array.isArray(paper.sections) && paper.sections.length > 0) {
        return paper.sections;
    }
    const totalQ = (paper && (paper.total_questions || paper.numQuestions)) || fallbackTotalQ || 50;
    const qPerSec = Math.ceil(totalQ / 4);
    return [
        { name: 'Physics', from_question: 1, to_question: qPerSec, max_marks: qPerSec * 4 },
        { name: 'Chemistry', from_question: qPerSec + 1, to_question: qPerSec * 2, max_marks: qPerSec * 4 },
        { name: 'Botany / Math', from_question: (qPerSec * 2) + 1, to_question: qPerSec * 3, max_marks: qPerSec * 4 },
        { name: 'Zoology / Aptitude', from_question: (qPerSec * 3) + 1, to_question: totalQ, max_marks: (totalQ - (qPerSec * 3)) * 4 }
    ].filter(s => s.to_question >= s.from_question);
}

// Shared helper to dynamically evaluate a submission against its paper's current answer key & sections
function buildGradedSubmissionObj(doc, paper) {
    const defaultTotalQ = (paper && (paper.total_questions || paper.numQuestions)) || 50;
    const totalQ = doc.totalQuestions || defaultTotalQ;
    const keyLookup = paper ? buildKeyLookup(paper) : {};

    // Special handling for JEE Mains submissions
    if (doc.examType === 'jee') {
        const numScores = doc.numericalScores || {};
        const sumArr = arr => Array.isArray(arr) ? arr.reduce((a, b) => a + Number(b || 0), 0) : 0;
        const phyNvq = sumArr(numScores.phy);
        const chemNvq = sumArr(numScores.chem);
        const mathNvq = sumArr(numScores.math);
        const mcqScores = doc.mcqSubjectScores || {};

        const phyMcq = (mcqScores.phy && mcqScores.phy.score !== undefined) ? mcqScores.phy.score : 0;
        const chemMcq = (mcqScores.chem && mcqScores.chem.score !== undefined) ? mcqScores.chem.score : 0;
        const mathMcq = (mcqScores.math && mcqScores.math.score !== undefined) ? mcqScores.math.score : 0;

        const sectionWise = [
            {
                sectionName: 'Physics',
                range: 'Q1-20 (MCQ) + Q21-25 (NVQ)',
                correct: mcqScores.phy ? mcqScores.phy.correct : 0,
                wrong: mcqScores.phy ? mcqScores.phy.wrong : 0,
                blank: mcqScores.phy ? mcqScores.phy.blank : 0,
                totalQuestions: 25,
                attempted: (mcqScores.phy ? (mcqScores.phy.correct + mcqScores.phy.wrong) : 0),
                unattempted: mcqScores.phy ? mcqScores.phy.blank : 0,
                marks: phyMcq + phyNvq,
                maxMarks: 100
            },
            {
                sectionName: 'Chemistry',
                range: 'Q41-60 (MCQ) + Q46-50 (NVQ)',
                correct: mcqScores.chem ? mcqScores.chem.correct : 0,
                wrong: mcqScores.chem ? mcqScores.chem.wrong : 0,
                blank: mcqScores.chem ? mcqScores.chem.blank : 0,
                totalQuestions: 25,
                attempted: (mcqScores.chem ? (mcqScores.chem.correct + mcqScores.chem.wrong) : 0),
                unattempted: mcqScores.chem ? mcqScores.chem.blank : 0,
                marks: chemMcq + chemNvq,
                maxMarks: 100
            },
            {
                sectionName: 'Mathematics',
                range: 'Q81-100 (MCQ) + Q71-75 (NVQ)',
                correct: mcqScores.math ? mcqScores.math.correct : 0,
                wrong: mcqScores.math ? mcqScores.math.wrong : 0,
                blank: mcqScores.math ? mcqScores.math.blank : 0,
                totalQuestions: 25,
                attempted: (mcqScores.math ? (mcqScores.math.correct + mcqScores.math.wrong) : 0),
                unattempted: mcqScores.math ? mcqScores.math.blank : 0,
                marks: mathMcq + mathNvq,
                maxMarks: 100
            }
        ];

        const obj = (typeof doc.toObject === 'function') ? doc.toObject({ virtuals: true }) : { ...doc };
        obj.sectionWise = sectionWise;
        obj.answerKeyLookup = keyLookup;
        obj.paperTitle = paper ? paper.title : (doc.paper_id || 'JEE Exam Paper');
        obj.paperSubject = 'JEE Mains';
        obj.maxMarks = 300;
        obj.aggregateMarks = doc.score !== undefined ? doc.score : 0;
        obj.allSectionsSummary = summarizeSections(sectionWise, obj).totals;
        return obj;
    }

    const sectionsDef = getPaperSectionsDef(paper, totalQ);

    if (Array.isArray(doc.responses) && doc.responses.length > 0 && paper) {
        const graded = evaluateResponsesAgainstKey(doc.responses, keyLookup, totalQ);
        doc.score = graded.score;
        doc.correctCount = graded.correctCount;
        doc.wrongCount = graded.wrongCount;
        doc.blankCount = graded.blankCount;
        doc.percentage = graded.percentage;
    }

    const resps = Array.isArray(doc.responses) ? doc.responses : [];
    const sectionWise = sectionsDef.map(s => {
        let secCorrect = 0;
        let secWrong = 0;
        let secBlank = 0;
        const fromQ = Number(s.from_question);
        const toQ = Number(s.to_question);
        const countInSec = (toQ >= fromQ) ? (toQ - fromQ + 1) : 0;

        for (let q = fromQ; q <= toQ; q++) {
            const marked = resps[q - 1] ? String(resps[q - 1]).trim().toUpperCase() : '';
            const key = keyLookup[q] ? String(keyLookup[q]).trim().toUpperCase() : '';
            if (!marked) {
                secBlank++;
            } else if (marked.includes(',')) {
                secWrong++;
            } else if (key && marked === key) {
                secCorrect++;
            } else if (key) {
                secWrong++;
            }
        }

        const secMarks = (secCorrect * 4) - secWrong;
        const secAttempted = Math.max(0, countInSec - secBlank);
        return {
            sectionName: s.name,
            range: `Q${fromQ}-Q${toQ}`,
            correct: secCorrect,
            wrong: secWrong,
            blank: secBlank,
            totalQuestions: countInSec,
            attempted: secAttempted,
            unattempted: secBlank,
            marks: Math.max(0, secMarks),
            maxMarks: s.max_marks || (countInSec * 4)
        };
    });

    const obj = doc.toObject({ virtuals: true });
    obj.sectionWise = sectionWise;
    obj.answerKeyLookup = keyLookup;
    obj.paperTitle = paper ? paper.title : (doc.paper_id || 'Exam Paper');
    obj.paperSubject = paper ? (paper.subject || 'General') : 'General';
    obj.maxMarks = paper ? (paper.max_marks || (totalQ * 4)) : (doc.maxMarks || (totalQ * 4));
    obj.allSectionsSummary = summarizeSections(sectionWise, obj).totals;
    return obj;
}

async function buildStudentNameMap(results) {
    const rollVariants = [];
    const lowerRolls = new Set();
    (results || []).forEach(r => {
        const roll = String((r && (r.rollnumber || r.rollNumber)) || '').trim();
        if (!roll) return;
        rollVariants.push(roll, roll.toUpperCase(), roll.toLowerCase());
        lowerRolls.add(roll.toLowerCase());
    });

    const uniqueRolls = [...new Set(rollVariants.filter(Boolean))];
    const studentNameByRoll = {};
    if (uniqueRolls.length > 0) {
        const users = await User.find({
            $or: [
                { rollnumber: { $in: uniqueRolls } },
                { username: { $in: [...lowerRolls] } }
            ]
        }, 'username rollnumber fullName').lean();

        users.forEach(u => {
            const name = u.fullName ? String(u.fullName).trim() : '';
            if (!name) return;
            if (u.rollnumber) studentNameByRoll[String(u.rollnumber).trim().toLowerCase()] = name;
            if (u.username) studentNameByRoll[String(u.username).trim().toLowerCase()] = name;
        });
    }
    return studentNameByRoll;
}

async function getSortedGradedPaperResults(paper) {
    const docs = await Submission.find({
        $or: [
            { paper_id: String(paper._id) },
            { paper_id: paper._id },
            { paperId: paper._id }
        ]
    }).sort({ score: -1, submitted_at: -1, scannedAt: -1 });

    const results = docs.map(doc => buildGradedSubmissionObj(doc, paper));
    results.sort((a, b) => {
        if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
        return new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0);
    });
    return results;
}

// Save Evaluated Result to Cloudinary & MongoDB (submissions collection)
app.post('/api/paper/:id/save-result', requireAdmin, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) return res.status(404).json({ error: 'Paper not found' });

        if (!req.body) {
            return res.status(400).json({ error: 'Missing request body' });
        }

        const {
            rollnumber,
            rollNumber,
            score,
            totalQuestions,
            correctCount,
            wrongCount,
            multipleCount,
            blankCount,
            breakdown,
            responses,
            imageData
        } = req.body;

        if (!imageData) {
            return res.status(400).json({ error: 'Image data is required' });
        }

        const studentRoll = (rollnumber || rollNumber || 'STUDENT-' + Date.now().toString().slice(-4)).toString().trim();
        const totalQ = Number(totalQuestions) || paper.numQuestions || 50;

        console.log(`[Save Result] Processing OMR submission for roll: "${studentRoll}" on paper: "${paper._id}"`);

        // Upload clean leveled OMR image to Cloudinary (using 5-account rotation)
        let uploadResult = null;
        try {
            uploadResult = await uploadOmrSheet(imageData, {
                rollNumber: studentRoll,
                paperId: String(paper._id)
            });
            console.log(`[Cloudinary] Successfully uploaded OMR copy for ${studentRoll} to account: ${uploadResult.account}`);
        } catch (cloudErr) {
            console.warn(`[Cloudinary Warning] Upload to Cloudinary pool failed (${cloudErr.message}). Saving copy locally as fallback.`);
            const filename = `omr_${Date.now()}_${studentRoll.replace(/[^\w-]/g, '_')}.jpg`;
            const localFilePath = path.join(uploadDir, filename);
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
            fs.writeFileSync(localFilePath, Buffer.from(base64Data, 'base64'));
            uploadResult = {
                url: '/uploads/' + filename,
                publicId: 'local_' + filename,
                account: 'local_storage'
            };
        }

        // Build 180 (or totalQ) responses array: ["A", "B", null, "C", ...]
        let responsesArray = [];
        if (Array.isArray(responses) && responses.length > 0) {
            responsesArray = responses;
        } else if (Array.isArray(breakdown)) {
            responsesArray = new Array(totalQ).fill(null);
            breakdown.forEach(item => {
                if (item && item.q) {
                    const idx = Number(item.q) - 1;
                    if (idx >= 0 && idx < totalQ) {
                        if (item.marked && typeof item.marked === 'string' && item.marked.trim() !== '' && item.verdict !== 'blank') {
                            responsesArray[idx] = item.marked.trim().toUpperCase();
                        } else {
                            responsesArray[idx] = null;
                        }
                    }
                }
            });
        }

        const graded = responsesArray.length > 0
            ? evaluateResponsesAgainstKey(responsesArray, buildKeyLookup(paper), totalQ)
            : {
                score: Number(score || 0),
                correctCount: Number(correctCount || 0),
                wrongCount: Number(wrongCount || 0),
                blankCount: Number(blankCount || 0),
                percentage: totalQ > 0 ? Math.round((Number(score || 0) / totalQ) * 100) : 0
            };

        const newSubmission = new Submission({
            rollnumber: studentRoll,
            paper_id: String(paper._id),
            submitted_at: new Date(),
            responses: responsesArray,
            cloudinary_image_url: uploadResult.url,
            cloudinary_public_id: uploadResult.publicId,
            cloudinary_account: uploadResult.account,
            score: graded.score,
            totalQuestions: totalQ,
            percentage: graded.percentage,
            maxMarks: paper.max_marks || (totalQ * 4),
            correctCount: graded.correctCount,
            wrongCount: graded.wrongCount,
            blankCount: graded.blankCount
        });

        await newSubmission.save();

        res.json({
            success: true,
            submissionId: newSubmission._id,
            resultId: newSubmission._id,
            rollnumber: newSubmission.rollnumber,
            paper_id: newSubmission.paper_id,
            cloudinary_image_url: newSubmission.cloudinary_image_url,
            cloudinary_public_id: newSubmission.cloudinary_public_id,
            omrImageUrl: newSubmission.cloudinary_image_url,
            aggregateMarks: newSubmission.aggregateMarks,
            responses: newSubmission.responses,
            cloudinaryAccount: uploadResult.account
        });
    } catch (error) {
        console.error('Error saving evaluation result:', error);
        res.status(500).json({ error: error.message });
    }
});

// Save JEE Mains Evaluated Result (Q1-20, Q41-60, Q81-100 + Section B Numerical)
app.post('/api/paper/:id/jee-save-result', requireAdmin, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) return res.status(404).json({ error: 'Paper not found' });

        if (!req.body) {
            return res.status(400).json({ error: 'Missing request body' });
        }

        const {
            rollnumber,
            rollNumber,
            score,
            totalQuestions,
            maxMarks,
            numericalScores,
            mcqSubjectScores,
            breakdown,
            imageData
        } = req.body;

        if (!imageData) {
            return res.status(400).json({ error: 'Image data is required' });
        }

        const studentRoll = (rollnumber || rollNumber || 'STUDENT-' + Date.now().toString().slice(-4)).toString().trim();
        const totalQ = Number(totalQuestions) || 75;
        const maxM = Number(maxMarks) || 300;
        const totalScore = Number(score !== undefined ? score : 0);

        console.log(`[JEE Save Result] Processing JEE OMR submission for roll: "${studentRoll}" on paper: "${paper._id}" (Score: ${totalScore}/${maxM})`);

        // Upload clean leveled OMR image to Cloudinary (using 5-account rotation)
        let uploadResult = null;
        try {
            uploadResult = await uploadOmrSheet(imageData, {
                rollNumber: studentRoll,
                paperId: String(paper._id)
            });
            console.log(`[Cloudinary] Successfully uploaded JEE OMR copy for ${studentRoll} to account: ${uploadResult.account}`);
        } catch (cloudErr) {
            console.warn(`[Cloudinary Warning] Upload to Cloudinary pool failed (${cloudErr.message}). Saving copy locally as fallback.`);
            const filename = `jee_omr_${Date.now()}_${studentRoll.replace(/[^\w-]/g, '_')}.jpg`;
            const localFilePath = path.join(uploadDir, filename);
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
            fs.writeFileSync(localFilePath, Buffer.from(base64Data, 'base64'));
            uploadResult = {
                url: '/uploads/' + filename,
                publicId: 'local_' + filename,
                account: 'local_storage'
            };
        }

        // Build 100-length responses array for JEE
        const responsesArray = new Array(100).fill(null);
        let correctCount = 0;
        let wrongCount = 0;
        let blankCount = 0;

        if (Array.isArray(breakdown)) {
            breakdown.forEach(item => {
                if (item && item.q) {
                    const idx = Number(item.q) - 1;
                    if (idx >= 0 && idx < 100) {
                        if (item.marked && typeof item.marked === 'string' && item.marked.trim() !== '' && item.verdict !== 'blank') {
                            responsesArray[idx] = item.marked.trim().toUpperCase();
                        }
                    }
                    if (item.verdict === 'correct') correctCount++;
                    else if (item.verdict === 'wrong' || item.verdict === 'multiple') wrongCount++;
                    else blankCount++;
                }
            });
        }

        // Numerical Questions grading tally
        const numScores = numericalScores || {};
        ['phy', 'chem', 'math'].forEach(sub => {
            const arr = numScores[sub] || [];
            arr.forEach(val => {
                const n = Number(val);
                if (n === 4) correctCount++;
                else if (n === -1) wrongCount++;
                else blankCount++;
            });
        });

        const percentage = maxM > 0 ? Math.round((totalScore / maxM) * 100) : 0;

        const newSubmission = new Submission({
            rollnumber: studentRoll,
            paper_id: String(paper._id),
            submitted_at: new Date(),
            responses: responsesArray,
            cloudinary_image_url: uploadResult.url,
            cloudinary_public_id: uploadResult.publicId,
            cloudinary_account: uploadResult.account,
            score: totalScore,
            totalQuestions: totalQ,
            percentage: percentage,
            maxMarks: maxM,
            correctCount: correctCount,
            wrongCount: wrongCount,
            blankCount: blankCount,
            examType: 'jee',
            numericalScores: numericalScores || {},
            mcqSubjectScores: mcqSubjectScores || {}
        });

        await newSubmission.save();

        res.json({
            success: true,
            submissionId: newSubmission._id,
            resultId: newSubmission._id,
            rollnumber: newSubmission.rollnumber,
            paper_id: newSubmission.paper_id,
            score: newSubmission.score,
            maxMarks: newSubmission.maxMarks,
            cloudinary_image_url: newSubmission.cloudinary_image_url,
            cloudinary_public_id: newSubmission.cloudinary_public_id,
            omrImageUrl: newSubmission.cloudinary_image_url,
            aggregateMarks: newSubmission.score,
            responses: newSubmission.responses,
            cloudinaryAccount: uploadResult.account
        });
    } catch (error) {
        console.error('Error saving JEE evaluation result:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete Submission and its associated Cloudinary image
app.delete('/api/submission/:id', requireAdmin, async (req, res) => {
    try {
        const submission = await Submission.findById(req.params.id);
        if (!submission) {
            return res.status(404).json({ error: 'Submission not found' });
        }

        const publicId = submission.cloudinary_public_id || submission.cloudinaryPublicId;
        const accountName = submission.cloudinary_account || submission.cloudinaryAccount;

        let cloudDeleted = false;
        if (publicId) {
            try {
                const delRes = await deleteOmrSheet(publicId, accountName);
                cloudDeleted = (delRes && delRes.result === 'ok');
            } catch (cloudErr) {
                console.warn('Notice: Could not delete from Cloudinary:', cloudErr.message);
            }
        }

        await Submission.findByIdAndDelete(req.params.id);

        res.json({
            success: true,
            message: 'Submission and Cloudinary OMR copy deleted successfully',
            deletedId: req.params.id,
            cloudinaryDeleted: cloudDeleted
        });
    } catch (error) {
        console.error('Error deleting submission:', error);
        res.status(500).json({ error: error.message });
    }
});

// Student Results Portal (scoped strictly to the signed-in student's roll number, or Admin lookup)
app.get('/student', requireAuth, async (req, res) => {
    try {
        const targetRoll = req.user.role === 'admin'
            ? String(req.query.roll || '').trim()
            : String(req.user.rollnumber || req.user.username || '').trim();

        let results = [];
        if (targetRoll) {
            const rollVariants = [...new Set([
                targetRoll,
                targetRoll.toUpperCase(),
                targetRoll.toLowerCase()
            ].filter(Boolean))];

            const docs = await Submission.find({
                $or: [
                    { rollnumber: { $in: rollVariants } },
                    { rollNumber: { $in: rollVariants } }
                ]
            }).sort({ submitted_at: -1, scannedAt: -1 });

            const paperIds = [...new Set(docs.map(d => d.paper_id || d.paperId).filter(Boolean).map(String))];
            const paperQueryIds = [];
            paperIds.forEach(pid => {
                paperQueryIds.push(pid);
                if (mongoose.Types.ObjectId.isValid(pid) && String(new mongoose.Types.ObjectId(pid)) === pid) {
                    paperQueryIds.push(new mongoose.Types.ObjectId(pid));
                }
            });

            const papers = paperQueryIds.length > 0
                ? await Paper.find({ _id: { $in: paperQueryIds } })
                : [];
            const papersMap = {};
            papers.forEach(p => {
                papersMap[String(p._id)] = p;
            });

            results = docs.map(doc => {
                const pid = String(doc.paper_id || doc.paperId || '');
                const paper = papersMap[pid] || null;
                return buildGradedSubmissionObj(doc, paper);
            });
        }

        res.render('student_dashboard', {
            results,
            targetRoll
        });
    } catch (error) {
        console.error('Error loading student dashboard:', error);
        res.status(500).send('Error loading student results: ' + error.message);
    }
});

// View All Results & Evaluated OMR Copies for Paper
app.get('/paper/:id/results', requireAdmin, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) return res.status(404).send('Paper not found');

        const results = await getSortedGradedPaperResults(paper);
        const studentNameByRoll = await buildStudentNameMap(results);
        results.forEach(r => {
            const roll = String(r.rollnumber || r.rollNumber || '').trim().toLowerCase();
            r.studentName = studentNameByRoll[roll] || '';
        });

        // Calculate Aggregate Stats (aligned with sum of all sections)
        let highestAggregate = 0;
        let totalAgg = 0;
        let totalPct = 0;
        const secDefs = getPaperSectionsDef(paper, paper.numQuestions || 50);
        const computedSecTotalMarks = secDefs.reduce((acc, s) => {
            const fromQ = Number(s.from_question);
            const toQ = Number(s.to_question);
            const qCount = (toQ >= fromQ) ? (toQ - fromQ + 1) : 0;
            return acc + (Number(s.max_marks) || (qCount * 4));
        }, 0);
        const maxMarks = computedSecTotalMarks || paper.max_marks || (paper.numQuestions || 50) * 4;

        // Section averages
        const secSums = {};

        results.forEach(r => {
            const agg = r.allSectionsSummary ? r.allSectionsSummary.obtainedMarks : ((r.aggregateMarks !== undefined) ? r.aggregateMarks : (r.score * 4));
            if (agg > highestAggregate) highestAggregate = agg;
            totalAgg += agg;
            totalPct += (r.percentage || 0);

            if (r.sectionWise && Array.isArray(r.sectionWise)) {
                r.sectionWise.forEach(s => {
                    if (!secSums[s.sectionName]) {
                        secSums[s.sectionName] = { marks: 0, count: 0, range: s.range, maxMarks: s.maxMarks };
                    }
                    secSums[s.sectionName].marks += s.marks;
                    secSums[s.sectionName].count++;
                });
            }
        });

        const totalCount = results.length;
        const averageAggregate = totalCount > 0 ? Math.round(totalAgg / totalCount) : 0;
        const averageAccuracy = totalCount > 0 ? Math.round(totalPct / totalCount) : 0;

        const sectionAverages = Object.keys(secSums).map(name => {
            const item = secSums[name];
            return {
                sectionName: name,
                range: item.range,
                maxMarks: item.maxMarks,
                avgMarks: Math.round(item.marks / item.count)
            };
        });

        const stats = {
            highestAggregate,
            averageAggregate,
            averageAccuracy,
            maxMarks,
            sectionAverages
        };

        res.render('paper_results', {
            paper,
            results,
            stats,
            answerKeyJson: getAnswerKeyJson(paper)
        });
    } catch (error) {
        console.error('Error loading paper results:', error);
        res.status(500).send('Error loading paper results: ' + error.message);
    }
});

// Download Detailed Section-Wise Results CSV (Admin Only)
app.get('/paper/:id/results/export', requireAdmin, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) return res.status(404).send('Paper not found');

        const results = await getSortedGradedPaperResults(paper);
        const studentNameByRoll = await buildStudentNameMap(results);

        const csv = buildDetailedResultsCsv({ paper, results, studentNameByRoll });
        const safeTitle = String(paper.title || 'Paper').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'Paper';
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_Detailed_Results.csv"`);
        res.send(csv);
    } catch (error) {
        console.error('Error exporting paper results:', error);
        res.status(500).send('Error exporting results: ' + error.message);
    }
});

// 404 Not Found Handler
app.use((req, res) => {
    if (isApiRequest(req)) {
        return res.status(404).json({ error: 'Endpoint not found' });
    }
    res.status(404).render('error', { message: 'The page or resource you requested could not be found.' });
});

// Centralized Safe Error Handler (Blocks internal paths & stack trace leaks in production)
app.use((err, req, res, next) => {
    console.error('[Unhandled Error]', err);
    if (res.headersSent) return next(err);

    const isApi = isApiRequest(req);
    const status = (typeof err.status === 'number' && err.status >= 400 && err.status < 600) ? err.status : 500;
    const safeMsg = (status >= 400 && status < 500)
        ? (err.message || 'Invalid Request')
        : (process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : (err.message || 'Server Error'));

    if (isApi) {
        return res.status(status).json({ error: safeMsg });
    }
    return res.status(status).render('error', { message: safeMsg });
});
