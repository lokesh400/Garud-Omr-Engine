const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const {
    getActiveConfig,
    setActiveConfig,
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

// 1. Dashboard & Google Sheet Setup
router.get('/', (req, res) => {
    const config = getActiveConfig();
    res.render(path.join(__dirname, 'views', 'index.ejs'), {
        config,
        appsScriptCode
    });
});

// 2. Save Google Sheet URL & Load Paper
router.post('/setup', async (req, res) => {
    try {
        const sheetUrl = String((req.body && req.body.sheetUrl) || '').trim();
        if (!sheetUrl) {
            return res.redirect('/ordinary?error=' + encodeURIComponent('Please enter a valid Google Sheet or Apps Script URL'));
        }

        const loadedConfig = await fetchPaperFromSheet(sheetUrl);
        console.log(`[Ordinary Checker] Successfully loaded paper "${loadedConfig.title}" with ${loadedConfig.totalQuestions} questions from Google Sheet.`);

        res.redirect('/ordinary?message=' + encodeURIComponent(`Paper "${loadedConfig.title}" successfully loaded from Google Sheet!`));
    } catch (err) {
        console.error('[Ordinary Checker Setup Error]:', err.message);
        res.redirect('/ordinary?error=' + encodeURIComponent(err.message));
    }
});

// 3. Live Camera Scanner View
router.get('/scanner', (req, res) => {
    const config = getActiveConfig();
    res.render(path.join(__dirname, 'views', 'scanner.ejs'), {
        config
    });
});

// 4. File Upload / Image Evaluator View
router.get('/evaluator', (req, res) => {
    const config = getActiveConfig();
    res.render(path.join(__dirname, 'views', 'evaluator.ejs'), {
        config
    });
});

// 5. API endpoint to save result to Google Sheet (No MongoDB, No Cloudinary)
router.post('/api/save-result', async (req, res) => {
    try {
        if (!req.body) {
            return res.status(400).json({ error: 'Missing request body' });
        }

        const { studentName, rollNumber, totalMarks, maxMarks, sectionMarks } = req.body;
        if (!studentName || !String(studentName).trim()) {
            return res.status(400).json({ error: 'Student name is required' });
        }

        console.log(`[Ordinary Checker] Saving result for student "${studentName}" (Total: ${totalMarks}) to Google Sheet...`);

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

// 6. API endpoint to retrieve current paper info
router.get('/api/paper', (req, res) => {
    res.json({ success: true, paper: getActiveConfig() });
});

module.exports = router;
