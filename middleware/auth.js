const { isValidId } = require('../utils/security');

const SESSION_COOKIE_NAME = 'garud.sid';

// Auth & RBAC Helpers
function isApiRequest(req) {
    if (req.originalUrl && req.originalUrl.startsWith('/api/')) return true;
    const accept = (req.headers && req.headers.accept) || '';
    const isJson = typeof req.is === 'function' ? req.is('application/json') : false;
    return Boolean(req.xhr || isJson || (accept.includes('application/json') && !accept.includes('text/html')));
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

function requireAdminOrTeacher(req, res, next) {
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
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
        if (isApiRequest(req)) {
            return res.status(403).json({ error: 'Staff access required' });
        }
        return res.status(403).render('forbidden');
    }
    return next();
}

// Resource ID Sanitizer (Protects against IDOR/injection via path parameters)
function validateIdParam(req, res, next, id) {
    if (!isValidId(id)) {
        if (isApiRequest(req)) {
            return res.status(400).json({ error: 'Invalid resource identifier format.' });
        }
        return res.status(400).render('error', { message: 'Invalid resource identifier format.' });
    }
    next();
}

module.exports = {
    SESSION_COOKIE_NAME,
    isApiRequest,
    getSafeReturnTo,
    requireAuth,
    requireAdmin,
    requireAdminOrTeacher,
    validateIdParam
};
