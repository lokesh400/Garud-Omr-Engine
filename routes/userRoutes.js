const express = require('express');
const router = express.Router();
const User = require('../models/User');
const {
    requireAdmin,
    isApiRequest,
    validateIdParam
} = require('../middleware/auth');
const { handleBulkUploadMiddleware } = require('../middleware/upload');
const {
    passwordChangeLimiter,
    isValidMongoId,
    isValidEmail
} = require('../utils/security');
const {
    parseBulkStudentsInput,
    annotateExistingUsers,
    generateStudentPassword,
    extractFirst3
} = require('../utils/bulkStudents');

router.param('id', validateIdParam);

// Admin User Management Routes
router.get('/users', requireAdmin, async (req, res) => {
    try {
        const users = await User.find()
            .select('-hash -salt -resetPasswordOtp -resetPasswordOtpExpires -resetPasswordOtpAttempts -resetPasswordLastRequestedAt')
            .sort({ role: 1, createdAt: -1 });
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
router.get('/users/bulk-template', requireAdmin, (req, res) => {
    const csv = [
        'roll_number,name,fathers_name,mothers_name',
        '01234567,Aarav Sharma,Rajesh Sharma,Sunita Sharma',
        '01234568,Priya Verma,Vikram Verma,Meena Verma'
    ].join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="students_bulk_template.csv"');
    res.send(csv);
});

// Preview & validate uploaded spreadsheet or pasted rows before creating accounts
router.post('/users/bulk/parse', requireAdmin, handleBulkUploadMiddleware, async (req, res) => {
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
router.post('/users/bulk', requireAdmin, handleBulkUploadMiddleware, async (req, res) => {
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
                        rollnumber: row.rollnumber,
                        phone: row.phone || '',
                        parentPhone: row.parentPhone || ''
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

router.post('/users', requireAdmin, async (req, res) => {
    try {
        const rawRole = String(req.body.role || '').toLowerCase();
        const role = rawRole === 'admin' ? 'admin' : (rawRole === 'teacher' ? 'teacher' : 'student');
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

        const email = String(req.body.email || '').trim().toLowerCase();
        if (email && !isValidEmail(email)) {
            return res.redirect('/users?error=' + encodeURIComponent('Please enter a valid email address.'));
        }

        const parentPhone = String(req.body.parentPhone || req.body.phone || '').replace(/\D/g, '');

        const newUser = new User({
            username,
            fullName,
            role,
            rollnumber,
            email,
            parentPhone
        });
        await User.register(newUser, password);
        return res.redirect('/users?message=' + encodeURIComponent(`Account @${username} (${role}) created successfully.`));
    } catch (err) {
        return res.redirect('/users?error=' + encodeURIComponent(err.message || 'Could not create user.'));
    }
});

router.post('/users/:id/email', requireAdmin, async (req, res) => {
    try {
        const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
        if (!isValidMongoId(req.params.id)) {
            if (wantsJson) return res.status(400).json({ success: false, error: 'Invalid user identifier.' });
            return res.redirect('/users?error=' + encodeURIComponent('Invalid user identifier.'));
        }
        const email = String((req.body && req.body.email) || '').trim().toLowerCase();
        if (email && !isValidEmail(email)) {
            if (wantsJson) return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
            return res.redirect('/users?error=' + encodeURIComponent('Please enter a valid email address.'));
        }
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) {
            if (wantsJson) return res.status(404).json({ success: false, error: 'User not found.' });
            return res.redirect('/users?error=' + encodeURIComponent('User not found.'));
        }
        targetUser.email = email;
        await targetUser.save();
        if (wantsJson) {
            return res.json({ success: true, message: `Email updated for @${targetUser.username}.`, email: targetUser.email });
        }
        return res.redirect('/users?message=' + encodeURIComponent(`Email updated for @${targetUser.username}.`));
    } catch (err) {
        const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
        if (wantsJson) return res.status(500).json({ success: false, error: err.message || 'Could not update email.' });
        return res.redirect('/users?error=' + encodeURIComponent(err.message || 'Could not update email.'));
    }
});

router.post('/users/:id/name', requireAdmin, async (req, res) => {
    try {
        const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
        if (!isValidMongoId(req.params.id)) {
            if (wantsJson) return res.status(400).json({ success: false, error: 'Invalid user identifier.' });
            return res.redirect('/users?error=' + encodeURIComponent('Invalid user identifier.'));
        }
        const fullName = String((req.body && req.body.fullName) || '').trim();
        if (!fullName) {
            if (wantsJson) return res.status(400).json({ success: false, error: 'Name cannot be empty.' });
            return res.redirect('/users?error=' + encodeURIComponent('Name cannot be empty.'));
        }
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) {
            if (wantsJson) return res.status(404).json({ success: false, error: 'User not found.' });
            return res.redirect('/users?error=' + encodeURIComponent('User not found.'));
        }
        targetUser.fullName = fullName;
        await targetUser.save();
        if (wantsJson) {
            return res.json({ success: true, message: `Name updated for @${targetUser.username}.`, user: { _id: targetUser._id, fullName: targetUser.fullName, username: targetUser.username } });
        }
        return res.redirect('/users?message=' + encodeURIComponent(`Name updated for @${targetUser.username}.`));
    } catch (err) {
        const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
        if (wantsJson) return res.status(500).json({ success: false, error: err.message || 'Could not update name.' });
        return res.redirect('/users?error=' + encodeURIComponent(err.message || 'Could not update name.'));
    }
});

router.post('/users/:id/phone', requireAdmin, async (req, res) => {
    try {
        const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
        if (!isValidMongoId(req.params.id)) {
            if (wantsJson) return res.status(400).json({ success: false, error: 'Invalid user identifier.' });
            return res.redirect('/users?error=' + encodeURIComponent('Invalid user identifier.'));
        }

        const rawPhone = String((req.body && (req.body.parentPhone || req.body.phone)) || '').trim();
        let cleanPhone = rawPhone.replace(/\D/g, '');

        // If user submitted with +91 or leading 0, strip country code
        if (cleanPhone.length > 10 && cleanPhone.startsWith('91')) {
            cleanPhone = cleanPhone.slice(2);
        } else if (cleanPhone.length > 10 && cleanPhone.startsWith('0')) {
            cleanPhone = cleanPhone.slice(1);
        }
        if (cleanPhone.length > 10) {
            cleanPhone = cleanPhone.slice(-10);
        }

        // Validate 10-digit format if not empty
        if (cleanPhone && cleanPhone.length !== 10) {
            const errStr = 'Please enter a valid 10-digit mobile number without +91.';
            if (wantsJson) return res.status(400).json({ success: false, error: errStr });
            return res.redirect('/users?error=' + encodeURIComponent(errStr));
        }

        const targetUser = await User.findById(req.params.id);
        if (!targetUser) {
            if (wantsJson) return res.status(404).json({ success: false, error: 'User not found.' });
            return res.redirect('/users?error=' + encodeURIComponent('User not found.'));
        }

        targetUser.parentPhone = cleanPhone;
        await targetUser.save();

        if (wantsJson) {
            return res.json({
                success: true,
                message: cleanPhone ? `Parent WhatsApp phone updated for @${targetUser.username}.` : `Phone removed for @${targetUser.username}.`,
                parentPhone: targetUser.parentPhone
            });
        }
        return res.redirect('/users?message=' + encodeURIComponent(`Parent phone updated for @${targetUser.username}.`));
    } catch (err) {
        const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
        if (wantsJson) return res.status(500).json({ success: false, error: err.message || 'Could not update phone.' });
        return res.redirect('/users?error=' + encodeURIComponent(err.message || 'Could not update phone.'));
    }
});

router.post('/users/:id/password', requireAdmin, passwordChangeLimiter.middleware(), async (req, res) => {
    try {
        const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
        if (!isValidMongoId(req.params.id)) {
            if (wantsJson) return res.status(400).json({ success: false, error: 'Invalid user identifier.' });
            return res.redirect('/users?error=' + encodeURIComponent('Invalid user identifier.'));
        }
        const password = String((req.body && req.body.password) || '');
        if (password.length < 6) {
            if (wantsJson) return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long.' });
            return res.redirect('/users?error=' + encodeURIComponent('Password must be at least 6 characters long.'));
        }
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) {
            if (wantsJson) return res.status(404).json({ success: false, error: 'User not found.' });
            return res.redirect('/users?error=' + encodeURIComponent('User not found.'));
        }
        await targetUser.setPassword(password);
        await targetUser.save();
        if (wantsJson) {
            return res.json({ success: true, message: `Password updated for @${targetUser.username}.` });
        }
        return res.redirect('/users?message=' + encodeURIComponent(`Password updated for @${targetUser.username}.`));
    } catch (err) {
        const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
        if (wantsJson) return res.status(500).json({ success: false, error: err.message || 'Could not update password.' });
        return res.redirect('/users?error=' + encodeURIComponent(err.message || 'Could not update password.'));
    }
});

router.post('/users/:id/delete', requireAdmin, async (req, res) => {
    try {
        const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
        if (!isValidMongoId(req.params.id)) {
            if (wantsJson) return res.status(400).json({ success: false, error: 'Invalid user identifier.' });
            return res.redirect('/users?error=' + encodeURIComponent('Invalid user identifier.'));
        }
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) {
            if (wantsJson) return res.status(404).json({ success: false, error: 'User not found.' });
            return res.redirect('/users?error=' + encodeURIComponent('User not found.'));
        }
        if (String(targetUser._id) === String(req.user._id)) {
            if (wantsJson) return res.status(400).json({ success: false, error: 'You cannot delete your own signed-in account.' });
            return res.redirect('/users?error=' + encodeURIComponent('You cannot delete your own signed-in account.'));
        }
        if (targetUser.role === 'admin') {
            const adminCount = await User.countDocuments({ role: 'admin' });
            if (adminCount <= 1) {
                if (wantsJson) return res.status(400).json({ success: false, error: 'Cannot delete the last remaining Admin account.' });
                return res.redirect('/users?error=' + encodeURIComponent('Cannot delete the last remaining Admin account.'));
            }
        }
        await User.findByIdAndDelete(targetUser._id);
        if (wantsJson) {
            return res.json({ success: true, message: `Account @${targetUser.username} deleted.` });
        }
        return res.redirect('/users?message=' + encodeURIComponent(`Account @${targetUser.username} deleted.`));
    } catch (err) {
        const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
        if (wantsJson) return res.status(500).json({ success: false, error: err.message || 'Could not delete user.' });
        return res.redirect('/users?error=' + encodeURIComponent(err.message || 'Could not delete user.'));
    }
});

module.exports = router;
