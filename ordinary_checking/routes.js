const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const {
    getEnvUrl,
    getAllPapers,
    getPaperById,
    getActiveConfig,
    setActivePaper,
    deletePaper,
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

// 1. Dashboard: List all papers and show active paper
router.get('/', (req, res) => {
    const papers = getAllPapers();
    const activePaper = getActiveConfig();
    res.render(path.join(__dirname, 'views', 'index.ejs'), {
        config: activePaper,
        papers: papers,
        envUrl: getEnvUrl(),
        message: req.query.message || null,
        error: req.query.error || null,
        appsScriptCode
    });
});

// 2. Create Paper Form
router.get('/paper/new', (req, res) => {
    res.render(path.join(__dirname, 'views', 'create_paper.ejs'), {
        paper: null,
        isNew: true
    });
});

// 3. Edit Paper Form
router.get('/paper/:id/edit', (req, res) => {
    const paper = getPaperById(req.params.id);
    res.render(path.join(__dirname, 'views', 'create_paper.ejs'), {
        paper: paper,
        isNew: false
    });
});

// 4. Process Paper Creation / Update (saves locally and creates dedicated tabs in Google Sheet)
router.post('/paper/new', async (req, res) => {
    try {
        const paperId = String((req.body && req.body.paperId) || '').trim();
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
            id: paperId || undefined,
            title,
            subject,
            totalQuestions,
            sections,
            answerKey
        });

        const syncMsg = outcome.cloudSynced
            ? `Paper "${outcome.paper.title}" saved! Created sheet tabs: "Key - ${outcome.paper.title}" and "Results - ${outcome.paper.title}".`
            : `Paper "${outcome.paper.title}" saved locally. (Ready for scanning)`;

        res.redirect('/ordinary?message=' + encodeURIComponent(syncMsg));
    } catch (err) {
        console.error('[Ordinary Checker Create Paper Error]:', err);
        res.redirect('/ordinary?error=' + encodeURIComponent(err.message));
    }
});

// 5. Switch Active Paper
router.post('/paper/:id/set-active', (req, res) => {
    const active = setActivePaper(req.params.id);
    res.redirect('/ordinary?message=' + encodeURIComponent(`Switched active paper to "${active.title}".`));
});

// 6. Delete Paper
router.post('/paper/:id/delete', (req, res) => {
    const deleted = deletePaper(req.params.id);
    res.redirect('/ordinary?message=' + encodeURIComponent(`Paper "${deleted ? deleted.title : req.params.id}" removed.`));
});

// 7. Force Sync / Refresh from Google Sheet
router.post('/sync-sheet', async (req, res) => {
    try {
        const paperTitle = req.body && req.body.paperTitle ? String(req.body.paperTitle).trim() : null;
        const synced = await fetchPaperFromSheet(null, paperTitle);
        res.redirect('/ordinary?message=' + encodeURIComponent(`Synced paper "${synced.title}" (${synced.totalQuestions} questions) from Google Sheet.`));
    } catch (err) {
        res.redirect('/ordinary?error=' + encodeURIComponent('Could not sync: ' + err.message));
    }
});

// Helper to prepare scanner/evaluator render data
function preparePaperRenderData(targetId, queryImage = '') {
    const targetPaper = getPaperById(targetId);
    const allPapers = getAllPapers();
    const paper = {
        ...targetPaper,
        _id: targetPaper.id || 'ordinary',
        numQuestions: targetPaper.totalQuestions || 180
    };
    return {
        config: paper,
        paper: paper,
        allPapers: allPapers,
        imagePath: queryImage,
        answerKey: JSON.stringify(paper.answerKey || {}).replace(/</g, '\\u003c')
    };
}

// 8. Live Camera Scanner Views
router.get('/scanner', (req, res) => {
    const data = preparePaperRenderData(req.query.paperId);
    res.render(path.join(__dirname, 'views', 'scanner.ejs'), data);
});

router.get('/paper/:id/scanner', (req, res) => {
    const data = preparePaperRenderData(req.params.id);
    res.render(path.join(__dirname, 'views', 'scanner.ejs'), data);
});

// 9. File Upload / Image Evaluator Views
router.get('/evaluator', (req, res) => {
    const data = preparePaperRenderData(req.query.paperId, req.query.image || '');
    res.render(path.join(__dirname, 'views', 'evaluator.ejs'), data);
});

router.get('/paper/:id/evaluator', (req, res) => {
    const data = preparePaperRenderData(req.params.id, req.query.image || '');
    res.render(path.join(__dirname, 'views', 'evaluator.ejs'), data);
});

// 10. API endpoint to save result to Google Sheet under that paper's results tab
router.post('/api/save-result', async (req, res) => {
    try {
        if (!req.body) {
            return res.status(400).json({ error: 'Missing request body' });
        }

        const { studentName, rollNumber, totalMarks, maxMarks, sectionMarks, paperId, paperTitle } = req.body;
        if (!studentName || !String(studentName).trim()) {
            return res.status(400).json({ error: 'Student name is required' });
        }

        console.log(`[Ordinary Checker] Saving result for student "${studentName}" (Marks: ${totalMarks}) under paper "${paperTitle || paperId || 'Active'}" to Google Sheet...`);

        const saveOutcome = await saveResultToSheet({
            paperId,
            paperTitle,
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
            totalMarks: saveOutcome.totalMarks,
            paperTitle: saveOutcome.paperTitle
        });
    } catch (err) {
        console.error('[Ordinary Checker Save Error]:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 11. API endpoints to retrieve paper(s)
router.get('/api/paper', (req, res) => {
    const paper = getPaperById(req.query.paperId);
    res.json({ success: true, paper });
});

router.get('/api/papers', (req, res) => {
    const papers = getAllPapers();
    res.json({ success: true, papers });
});

module.exports = router;
