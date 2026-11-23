const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const {
    getEnvUrl,
    getActiveConfig,
    createOrUpdatePaper,
    fetchPaperFromSheet,
    saveResultToSheet
} = require('./googleSheetService');

const appsScriptPath = path.join(__dirname, 'GoogleAppsScript.gs');
let appsScriptCode = '';
try {
    appsScriptCode = fs.readFileSync(appsScriptPath, 'utf8');
} catch (e) {
    appsScriptCode = '// GoogleAppsScript.gs not found';
}

// 1. Dashboard
router.get('/', (req, res) => {
    const config = getActiveConfig();
    res.render(path.join(__dirname, 'views', 'index.ejs'), {
        config,
        envUrl: getEnvUrl(),
        message: req.query.message || null,
        error: req.query.error || null,
        appsScriptCode
    });
});

// 2. Create Paper Form (Same style as NEET/JEE)
router.get('/paper/new', (req, res) => {
    const config = getActiveConfig();
    res.render(path.join(__dirname, 'views', 'create_paper.ejs'), {
        config
    });
});

// 3. Process Paper Creation (saves locally and syncs to Google Sheet)
router.post('/paper/new', async (req, res) => {
    try {
        const title = String((req.body && req.body.title) || 'Ordinary Assessment').trim();
        const subject = String((req.body && req.body.subject) || 'General').trim();
        const totalQuestions = Number((req.body && req.body.totalQuestions) || 180);

        let sections = [];
        const rawSections = req.body && req.body.sectionsJson;
        if (typeof rawSections === 'string' && rawSections.trim() !== '') {
            try {
                sections = JSON.parse(rawSections);
            } catch (e) {
                console.warn('[Ordinary Checker] Invalid sections JSON:', e.message);
            }
        }

        let answerKey = {};
        const rawKey = req.body && req.body.answerKeyJson;
        if (typeof rawKey === 'string' && rawKey.trim() !== '') {
            try {
                answerKey = JSON.parse(rawKey);
            } catch (e) {
                console.warn('[Ordinary Checker] Invalid answerKey JSON:', e.message);
            }
        }

        const outcome = await createOrUpdatePaper({
            title,
            subject,
            totalQuestions,
            sections,
            answerKey
        });

        const syncMsg = outcome.cloudSynced
            ? 'Paper created and synced to Google Sheet!'
            : 'Paper created and saved. (Ready for scanning)';

        res.redirect('/ordinary?message=' + encodeURIComponent(syncMsg));
    } catch (err) {
        console.error('[Ordinary Checker Create Paper Error]:', err);
        res.redirect('/ordinary?error=' + encodeURIComponent(err.message));
    }
});

// 4. Force Sync / Refresh from Google Sheet
router.post('/sync-sheet', async (req, res) => {
    try {
        const synced = await fetchPaperFromSheet();
        res.redirect('/ordinary?message=' + encodeURIComponent(`Synced paper "${synced.title}" (${synced.totalQuestions} questions) from Google Sheet.`));
    } catch (err) {
        res.redirect('/ordinary?error=' + encodeURIComponent('Could not sync: ' + err.message));
    }
});

// 5. Live Camera Scanner View
router.get('/scanner', (req, res) => {
    const config = getActiveConfig();
    res.render(path.join(__dirname, 'views', 'scanner.ejs'), {
        config
    });
});

// 6. File Upload / Image Evaluator View
router.get('/evaluator', (req, res) => {
    const config = getActiveConfig();
    res.render(path.join(__dirname, 'views', 'evaluator.ejs'), {
        config
    });
});

// 7. API endpoint to save result to Google Sheet (Zero MongoDB, Zero Cloudinary)
router.post('/api/save-result', async (req, res) => {
    try {
        if (!req.body) {
            return res.status(400).json({ error: 'Missing request body' });
        }

        const { studentName, rollNumber, totalMarks, maxMarks, sectionMarks } = req.body;
        if (!studentName || !String(studentName).trim()) {
            return res.status(400).json({ error: 'Student name is required' });
        }

        console.log(`[Ordinary Checker] Saving result for student "${studentName}" (Marks: ${totalMarks}) to Google Sheet...`);

        const saveOutcome = await saveResultToSheet({
            studentName: String(studentName).trim(),
            rollNumber: String(rollNumber || '-').trim(),
            totalMarks: totalMarks,
            maxMarks: maxMarks,
            sectionMarks: sectionMarks || {}
        });

        res.json({
            success: true,
            message: saveOutcome.message,
            studentName: saveOutcome.studentName,
            totalMarks: saveOutcome.totalMarks
        });
    } catch (err) {
        console.error('[Ordinary Checker Save Error]:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 8. API endpoint to retrieve current paper info
router.get('/api/paper', (req, res) => {
    res.json({ success: true, paper: getActiveConfig() });
});

module.exports = router;
