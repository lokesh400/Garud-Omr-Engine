const fs = require('fs');
const path = require('path');

const PAPERS_STORE_PATH = path.join(__dirname, 'papers.json');
const ACTIVE_PAPER_PATH = path.join(__dirname, 'active_paper.json');

function getEnvUrl() {
    return (
        process.env.deployment_url ||
        process.env.DEPLOYMENT_URL ||
        process.env.GOOGLE_SHEET_APP_URL ||
        process.env.ORDINARY_SHEET_URL ||
        ''
    ).trim();
}

// In-memory paper database
let papersState = {
    activePaperId: '',
    papers: []
};

// Default initial paper
function createDefaultPaper() {
    const id = 'paper_' + Date.now();
    return {
        id: id,
        _id: id,
        title: 'Full NEET Mock Test 01',
        subject: 'Physics, Chemistry, Biology',
        totalQuestions: 180,
        maxMarks: 720,
        sections: [
            { name: 'Physics', from: 1, to: 45, maxMarks: 180 },
            { name: 'Chemistry', from: 46, to: 90, maxMarks: 180 },
            { name: 'Botany', from: 91, to: 135, maxMarks: 180 },
            { name: 'Zoology', from: 136, to: 180, maxMarks: 180 }
        ],
        answerKey: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
}

// Load local papers from disk (supports migration from active_paper.json)
function loadPapersFromDisk() {
    try {
        if (fs.existsSync(PAPERS_STORE_PATH)) {
            const raw = fs.readFileSync(PAPERS_STORE_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.papers) && parsed.papers.length > 0) {
                papersState.papers = parsed.papers.map(p => ({
                    ...p,
                    id: p.id || p._id || ('paper_' + Math.random().toString(36).substring(2, 9)),
                    _id: p._id || p.id
                }));
                papersState.activePaperId = parsed.activePaperId || papersState.papers[0].id;
                return;
            }
        }

        // Migrate from legacy active_paper.json if papers.json doesn't exist
        if (fs.existsSync(ACTIVE_PAPER_PATH)) {
            const raw = fs.readFileSync(ACTIVE_PAPER_PATH, 'utf8');
            const legacy = JSON.parse(raw);
            if (legacy && typeof legacy === 'object') {
                const legacyId = 'paper_' + Date.now();
                const initialPaper = {
                    ...legacy,
                    id: legacyId,
                    _id: legacyId,
                    title: legacy.title || 'Full NEET Mock Test 01',
                    subject: legacy.subject || 'Physics, Chemistry, Biology',
                    totalQuestions: Number(legacy.totalQuestions) || 180,
                    maxMarks: Number(legacy.maxMarks) || 720,
                    sections: Array.isArray(legacy.sections) ? legacy.sections : [],
                    answerKey: legacy.answerKey || {},
                    createdAt: legacy.updatedAt || new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                papersState.papers = [initialPaper];
                papersState.activePaperId = legacyId;
                savePapersToDisk();
                return;
            }
        }

        // Fallback: create fresh default
        const def = createDefaultPaper();
        papersState.papers = [def];
        papersState.activePaperId = def.id;
        savePapersToDisk();
    } catch (e) {
        console.warn('[Ordinary Checker] Notice initializing papers state:', e.message);
        if (papersState.papers.length === 0) {
            const def = createDefaultPaper();
            papersState.papers = [def];
            papersState.activePaperId = def.id;
        }
    }
}

// Save all papers to disk and update active_paper.json
function savePapersToDisk() {
    try {
        fs.writeFileSync(PAPERS_STORE_PATH, JSON.stringify(papersState, null, 2), 'utf8');
        
        // Also update active_paper.json for backwards compatibility
        const active = getActiveConfig();
        fs.writeFileSync(ACTIVE_PAPER_PATH, JSON.stringify(active, null, 2), 'utf8');
    } catch (e) {
        console.error('[Ordinary Checker] Error writing papers to disk:', e.message);
    }
}

loadPapersFromDisk();

// Get list of all papers
function getAllPapers() {
    return papersState.papers.map(p => ({
        ...p,
        isActive: p.id === papersState.activePaperId,
        url: getEnvUrl()
    }));
}

// Get specific paper by id
function getPaperById(id) {
    if (!id) return getActiveConfig();
    const cleanId = String(id).trim();
    const found = papersState.papers.find(p => p.id === cleanId || p._id === cleanId);
    if (found) {
        return {
            ...found,
            isActive: found.id === papersState.activePaperId,
            url: getEnvUrl()
        };
    }
    return getActiveConfig();
}

// Get the currently active paper
function getActiveConfig() {
    let active = papersState.papers.find(p => p.id === papersState.activePaperId);
    if (!active && papersState.papers.length > 0) {
        active = papersState.papers[0];
        papersState.activePaperId = active.id;
    }
    if (!active) {
        active = createDefaultPaper();
        papersState.papers = [active];
        papersState.activePaperId = active.id;
        savePapersToDisk();
    }
    return {
        ...active,
        isActive: true,
        url: getEnvUrl()
    };
}

// Set active paper
function setActivePaper(id) {
    const cleanId = String(id).trim();
    const found = papersState.papers.find(p => p.id === cleanId || p._id === cleanId);
    if (found) {
        papersState.activePaperId = found.id;
        savePapersToDisk();
        return found;
    }
    return getActiveConfig();
}

// Delete paper
function deletePaper(id) {
    const cleanId = String(id).trim();
    const idx = papersState.papers.findIndex(p => p.id === cleanId || p._id === cleanId);
    if (idx !== -1) {
        const deleted = papersState.papers.splice(idx, 1)[0];
        if (papersState.activePaperId === cleanId) {
            papersState.activePaperId = papersState.papers.length > 0 ? papersState.papers[0].id : '';
        }
        if (papersState.papers.length === 0) {
            const def = createDefaultPaper();
            papersState.papers.push(def);
            papersState.activePaperId = def.id;
        }
        savePapersToDisk();
        return deleted;
    }
    return null;
}

// Create or update a paper (multi-paper support)
async function createOrUpdatePaper(paperData) {
    const totalQ = Number(paperData.totalQuestions) || 180;
    const maxM = Number(paperData.maxMarks) || (totalQ * 4);
    const sections = Array.isArray(paperData.sections) && paperData.sections.length > 0
        ? paperData.sections
        : [
            { name: 'Physics', from: 1, to: Math.min(45, totalQ), maxMarks: Math.min(45, totalQ) * 4 },
            { name: 'Chemistry', from: 46, to: Math.min(90, totalQ), maxMarks: Math.max(0, Math.min(90, totalQ) - 45) * 4 },
            { name: 'Botany', from: 91, to: Math.min(135, totalQ), maxMarks: Math.max(0, Math.min(135, totalQ) - 90) * 4 },
            { name: 'Zoology', from: 136, to: Math.min(180, totalQ), maxMarks: Math.max(0, Math.min(180, totalQ) - 135) * 4 }
        ].filter(s => s.to >= s.from);

    const title = String(paperData.title || 'Ordinary Assessment').trim();
    const subject = String(paperData.subject || 'General').trim();
    const answerKey = paperData.answerKey || {};

    let targetId = paperData.id || paperData.paperId;
    let existingIndex = -1;

    if (targetId) {
        existingIndex = papersState.papers.findIndex(p => p.id === targetId || p._id === targetId);
    }

    let paperRecord;
    if (existingIndex !== -1) {
        // Update existing paper
        paperRecord = {
            ...papersState.papers[existingIndex],
            title,
            subject,
            totalQuestions: totalQ,
            maxMarks: maxM,
            sections,
            answerKey,
            updatedAt: new Date().toISOString()
        };
        papersState.papers[existingIndex] = paperRecord;
    } else {
        // Create brand new paper
        const newId = 'paper_' + Date.now();
        paperRecord = {
            id: newId,
            _id: newId,
            title,
            subject,
            totalQuestions: totalQ,
            maxMarks: maxM,
            sections,
            answerKey,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        papersState.papers.push(paperRecord);
        papersState.activePaperId = newId;
    }

    savePapersToDisk();

    // Push to Google Apps Script so dedicated Key sheet & Results sheet are created
    const targetUrl = getEnvUrl();
    let cloudSynced = false;
    let syncError = null;

    if (targetUrl && targetUrl.includes('script.google.com/macros/s/')) {
        try {
            const res = await fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'savePaper',
                    paperId: paperRecord.id,
                    title: paperRecord.title,
                    subject: paperRecord.subject,
                    totalQuestions: paperRecord.totalQuestions,
                    sections: paperRecord.sections,
                    answerKey: paperRecord.answerKey
                }),
                signal: AbortSignal.timeout(15000)
            });
            const data = await res.json();
            cloudSynced = Boolean(data && data.success);
        } catch (err) {
            syncError = err.message;
            console.warn('[Ordinary Checker] Notice syncing paper to Google Sheet:', err.message);
        }
    }

    return {
        success: true,
        paper: paperRecord,
        cloudSynced,
        syncError
    };
}

// Fetch paper details & answer key from Google Sheet
async function fetchPaperFromSheet(rawUrl, paperTitle = null) {
    const targetUrl = (rawUrl || getEnvUrl() || '').trim();
    if (!targetUrl) {
        throw new Error('Google Sheet or Web App URL is required (set deployment_url in .env)');
    }

    if (targetUrl.includes('script.google.com/macros/s/')) {
        let fetchEndpoint = targetUrl;
        if (paperTitle) {
            const separator = fetchEndpoint.includes('?') ? '&' : '?';
            fetchEndpoint += `${separator}paperTitle=${encodeURIComponent(paperTitle)}`;
        }

        const res = await fetch(fetchEndpoint, {
            headers: { 'User-Agent': 'OMR-Ordinary-Checker/1.0' },
            signal: AbortSignal.timeout(10000)
        });

        if (!res.ok) {
            throw new Error(`Google Apps Script returned HTTP ${res.status}: ${res.statusText}`);
        }

        const data = await res.json();
        if (!data || !data.success) {
            throw new Error((data && data.error) || 'Failed to fetch AnswerKey from Google Apps Script');
        }

        const title = data.title || paperTitle || 'Sheet Paper';
        const totalQ = Number(data.totalQuestions) || Object.keys(data.answerKey || {}).length || 180;
        const sections = Array.isArray(data.sections) && data.sections.length > 0 ? data.sections : [];

        // Check if paper exists by title
        const existing = papersState.papers.find(p => p.title.toLowerCase() === title.toLowerCase());
        const outcome = await createOrUpdatePaper({
            id: existing ? existing.id : undefined,
            title: title,
            subject: (existing && existing.subject) || 'General',
            totalQuestions: totalQ,
            sections: sections,
            answerKey: data.answerKey || {}
        });

        return outcome.paper;
    }

    throw new Error('Invalid Google Sheet URL format. Please provide a Google Apps Script Web App URL.');
}

// Append student's section marks & total marks to the Google Sheet under that paper's results tab
async function saveResultToSheet(payload, overrideUrl = null) {
    const targetUrl = (overrideUrl || getEnvUrl() || '').trim();
    if (!targetUrl) {
        throw new Error('Google Sheet deployment_url is not set in .env.');
    }

    if (!targetUrl.includes('script.google.com/macros/s/')) {
        throw new Error('Please ensure deployment_url in .env is a valid Google Apps Script Web App URL.');
    }

    // Resolve paper details
    const paper = getPaperById(payload.paperId);
    const paperTitle = String(payload.paperTitle || (paper && paper.title) || '').trim();
    const paperId = String(payload.paperId || (paper && paper.id) || '').trim();

    const studentName = String(payload.studentName || 'Anonymous Student').trim();
    const rollNumber = String(payload.rollNumber || '-').trim();
    const totalMarks = Number(payload.totalMarks !== undefined ? payload.totalMarks : (payload.score || 0));
    const maxMarks = Number(payload.maxMarks || ((paper ? paper.totalQuestions : 180) * 4));
    const sectionMarks = payload.sectionMarks || {};

    const postBody = {
        action: 'saveResult',
        paperId: paperId,
        paperTitle: paperTitle,
        studentName,
        rollNumber,
        sectionMarks,
        totalMarks,
        maxMarks,
        timestamp: new Date().toISOString()
    };

    const res = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(postBody),
        signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
        throw new Error(`Google Apps Script returned error ${res.status}: ${res.statusText}`);
    }

    const json = await res.json();
    return {
        success: true,
        message: (json && json.message) || `Result saved for ${studentName} in sheet tab "${paperTitle ? 'Results - ' + paperTitle : 'Results'}"`,
        studentName,
        totalMarks,
        paperTitle
    };
}

module.exports = {
    getEnvUrl,
    getAllPapers,
    getPaperById,
    getActiveConfig,
    setActivePaper,
    deletePaper,
    createOrUpdatePaper,
    fetchPaperFromSheet,
    saveResultToSheet
};
