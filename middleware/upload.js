const path = require('path');
const { isApiRequest } = require('./auth');
const { secureSpreadsheetUpload, uploadDir } = require('../utils/security');

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

function protectedUploadsHandler(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:;");

    // Path traversal defense
    const requestedPath = path.normalize(req.path);
    const fullPath = path.join(uploadDir, requestedPath);
    if (!fullPath.startsWith(uploadDir)) {
        return res.status(403).send('Forbidden: Path Traversal Detected');
    }

    if (req.user.role === 'admin' || req.user.role === 'teacher') return next();
    const roll = String(req.user.rollnumber || req.user.username || '').trim().replace(/[^\w-]/g, '_');
    const basename = path.basename(req.path || '');
    if (roll && basename.toLowerCase().includes(roll.toLowerCase())) {
        return next();
    }
    return res.status(403).send('Forbidden');
}

module.exports = {
    handleBulkUploadMiddleware,
    protectedUploadsHandler
};
