const dns = require('dns');
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const passport = require('passport');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const {
    mongoConnectPromise,
    sessionStore,
    ensureDefaultAdmin,
    startSelfPing
} = require('./config/db');
const configurePassport = require('./config/passport');
const {
    globalLimiter,
    apiLimiter,
    securityHeaders,
    sanitizeMongo,
    csrfProtection,
    uploadDir
} = require('./utils/security');
const {
    SESSION_COOKIE_NAME,
    isApiRequest,
    requireAuth,
    validateIdParam
} = require('./middleware/auth');
const { protectedUploadsHandler } = require('./middleware/upload');

// Routers
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const paperRoutes = require('./routes/paperRoutes');
const scanRoutes = require('./routes/scanRoutes');
const resultsRoutes = require('./routes/resultsRoutes');
const studentRoutes = require('./routes/studentRoutes');

const app = express();

// Disable information disclosure & enable reverse proxy trust
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = process.env.PORT || (process.env.RENDER ? 10000 : 3000);

// Ensure upload directory exists
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Global Rate Limiter (Protects against DDoS, brute-force floods, & crawling)
app.use((req, res, next) => {
    if (req.path.startsWith('/css') || req.path === '/healthz' || req.path === '/health' || req.path === '/ping') {
        return next();
    }
    return globalLimiter.middleware()(req, res, next);
});

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
configurePassport(passport);

app.use((req, res, next) => {
    res.locals.currentUser = req.user || null;
    next();
});

// Protect uploaded/fallback OMR copies (students can only read fallback copies tied to their own roll)
app.use('/uploads', requireAuth, protectedUploadsHandler, express.static(uploadDir, { dotfiles: 'ignore', index: false }));

// Resource ID Sanitizer (Protects against IDOR/injection via path parameters)
app.param('id', validateIdParam);

// Mount modular route handlers
app.use('/', authRoutes);
app.use('/', userRoutes);
app.use('/', paperRoutes);
app.use('/', scanRoutes);
app.use('/', resultsRoutes);
app.use('/', studentRoutes);

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

// Connect Database & Start Server
mongoConnectPromise
    .then(async () => {
        console.log('Connected to MongoDB');
        await ensureDefaultAdmin();
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`[Security Hardened] Server running on http://0.0.0.0:${PORT} (PORT=${PORT})`);
            startSelfPing(PORT);
        });
    })
    .catch(err => console.error('MongoDB connection error:', err));

module.exports = app;
