/**
 * =========================================================================
 * GARUD OMR - PURE GOOGLE SHEETS STORAGE SERVICE (ZERO LOCAL FILES)
 * =========================================================================
 * All papers, answer keys, and results are stored in Google Sheets only.
 * No JSON or database files are written to the local disk.
 */

function getEnvUrl() {
    return (
        process.env.deployment_url ||
        process.env.DEPLOYMENT_URL ||
        process.env.GOOGLE_SHEET_APP_URL ||
        process.env.ORDINARY_SHEET_URL ||
        ''
    ).trim();
}

// In-memory runtime cache (Never written to disk)
let inMemoryPapers = [];
let inMemoryActivePaperId = '';
let lastSyncTimestamp = 0;

function createDefaultFallbackPaper() {
    return {
        id: 'Paper_Default_NEET',
        _id: 'Paper_Default_NEET',
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
        keySheet: 'Paper - Full NEET Mock Test 01',
        resultsSheet: 'Results - Full NEET Mock Test 01'
    };
}

// Fetch all papers directly from Google Sheets
async function syncPapersFromSheet(force = false) {
    const targetUrl = getEnvUrl();
    if (!targetUrl || !targetUrl.includes('script.google.com/macros/s/')) {
        if (inMemoryPapers.length === 0) {
            inMemoryPapers = [createDefaultFallbackPaper()];
            inMemoryActivePaperId = inMemoryPapers[0].id;
        }
        return inMemoryPapers;
    }

    const now = Date.now();
    // Throttle automatic syncing to every 4 seconds unless forced
    if (!force && inMemoryPapers.length > 0 && (now - lastSyncTimestamp < 4000)) {
        return inMemoryPapers;
    }

    try {
        const res = await fetch(targetUrl, {
            headers: { 'User-Agent': 'OMR-Ordinary-Checker/1.0' },
            signal: AbortSignal.timeout(12000)
        });

        if (!res.ok) {
            throw new Error(`Google Apps Script returned HTTP ${res.status}: ${res.statusText}`);
        }

        const data = await res.json();
        lastSyncTimestamp = Date.now();

        if (data && data.success) {
            if (Array.isArray(data.papers) && data.papers.length > 0) {
                // Multi-paper array returned from updated Google Apps Script
                inMemoryPapers = data.papers.map(p => ({
                    ...p,
                    id: p.id || p._id || p.title,
                    _id: p._id || p.id || p.title,
                    totalQuestions: Number(p.totalQuestions) || Object.keys(p.answerKey || {}).length || 180,
                    maxMarks: Number(p.maxMarks) || ((Number(p.totalQuestions) || 180) * 4),
                    sections: Array.isArray(p.sections) ? p.sections : []
                }));

                if (!inMemoryActivePaperId || !inMemoryPapers.some(p => p.id === inMemoryActivePaperId)) {
                    inMemoryActivePaperId = inMemoryPapers[0].id;
                }
            } else if (data.answerKey || data.title) {
                // Single paper returned from legacy Apps Script
                const singleTitle = (data.title && data.title !== 'AnswerKey') ? data.title : 'Assessment 01';
                const totalQ = Number(data.totalQuestions) || Object.keys(data.answerKey || {}).length || 180;
                const singlePaper = {
                    id: singleTitle,
                    _id: singleTitle,
                    title: singleTitle,
                    subject: 'General',
                    totalQuestions: totalQ,
                    maxMarks: totalQ * 4,
                    sections: Array.isArray(data.sections) ? data.sections : [],
                    answerKey: data.answerKey || {},
                    keySheet: 'Paper - ' + singleTitle,
                    resultsSheet: 'Results - ' + singleTitle
                };
                inMemoryPapers = [singlePaper];
                inMemoryActivePaperId = singlePaper.id;
            }
        }
    } catch (err) {
        console.warn('[Ordinary Checker] Notice fetching papers from Google Sheet:', err.message);
        if (inMemoryPapers.length === 0) {
            inMemoryPapers = [createDefaultFallbackPaper()];
            inMemoryActivePaperId = inMemoryPapers[0].id;
        }
    }

    return inMemoryPapers;
}

// Get all papers (with active flag attached)
function getAllPapers() {
    if (inMemoryPapers.length === 0) {
        inMemoryPapers = [createDefaultFallbackPaper()];
        inMemoryActivePaperId = inMemoryPapers[0].id;
    }
    return inMemoryPapers.map(p => ({
        ...p,
        isActive: p.id === inMemoryActivePaperId,
        url: getEnvUrl()
    }));
}

// Get specific paper by id or title
function getPaperById(id) {
    if (!id) return getActiveConfig();
    const clean = String(id).trim().toLowerCase();
    const found = inMemoryPapers.find(p =>
        (p.id && p.id.toLowerCase() === clean) ||
        (p._id && p._id.toLowerCase() === clean) ||
        (p.title && p.title.toLowerCase() === clean)
    );
    if (found) {
        return {
            ...found,
            isActive: found.id === inMemoryActivePaperId,
            url: getEnvUrl()
        };
    }
    return getActiveConfig();
}

// Get currently active paper
function getActiveConfig() {
    let active = inMemoryPapers.find(p => p.id === inMemoryActivePaperId);
    if (!active && inMemoryPapers.length > 0) {
        active = inMemoryPapers[0];
        inMemoryActivePaperId = active.id;
    }
    if (!active) {
        active = createDefaultFallbackPaper();
        inMemoryPapers = [active];
        inMemoryActivePaperId = active.id;
    }
    return {
        ...active,
        isActive: true,
        url: getEnvUrl()
    };
}

// Set active paper
function setActivePaper(id) {
    const clean = String(id).trim().toLowerCase();
    const found = inMemoryPapers.find(p =>
        (p.id && p.id.toLowerCase() === clean) ||
        (p._id && p._id.toLowerCase() === clean) ||
        (p.title && p.title.toLowerCase() === clean)
    );
    if (found) {
        inMemoryActivePaperId = found.id;
        return found;
    }
    return getActiveConfig();
}

// Delete paper from runtime cache
function deletePaper(id) {
    const clean = String(id).trim().toLowerCase();
    const idx = inMemoryPapers.findIndex(p =>
        (p.id && p.id.toLowerCase() === clean) ||
        (p._id && p._id.toLowerCase() === clean) ||
        (p.title && p.title.toLowerCase() === clean)
    );
    if (idx !== -1) {
        const deleted = inMemoryPapers.splice(idx, 1)[0];
        if (inMemoryActivePaperId === deleted.id) {
            inMemoryActivePaperId = inMemoryPapers.length > 0 ? inMemoryPapers[0].id : '';
        }
        return deleted;
    }
    return null;
}

// Create or update paper in Google Sheets directly (ZERO local disk writes)
async function createOrUpdatePaper(paperData) {
    const totalQ = Number(paperData.totalQuestions) || 180;
    const maxM = Number(paperData.maxMarks) || (totalQ * 4);
    const title = String(paperData.title || 'Ordinary Assessment').trim();
    const subject = String(paperData.subject || 'General').trim();
    const answerKey = paperData.answerKey || {};

    const sections = Array.isArray(paperData.sections) && paperData.sections.length > 0
        ? paperData.sections
        : [
            { name: 'Physics', from: 1, to: Math.min(45, totalQ), maxMarks: Math.min(45, totalQ) * 4 },
            { name: 'Chemistry', from: 46, to: Math.min(90, totalQ), maxMarks: Math.max(0, Math.min(90, totalQ) - 45) * 4 },
            { name: 'Botany', from: 91, to: Math.min(135, totalQ), maxMarks: Math.max(0, Math.min(135, totalQ) - 90) * 4 },
            { name: 'Zoology', from: 136, to: Math.min(180, totalQ), maxMarks: Math.max(0, Math.min(180, totalQ) - 135) * 4 }
        ].filter(s => s.to >= s.from);

    const paperObj = {
        id: title,
        _id: title,
        title: title,
        subject: subject,
        totalQuestions: totalQ,
        maxMarks: maxM,
        sections: sections,
        answerKey: answerKey,
        keySheet: 'Paper - ' + title,
        resultsSheet: 'Results - ' + title
    };

    // Update in-memory list (NO disk write)
    const existingIdx = inMemoryPapers.findIndex(p => p.title.toLowerCase() === title.toLowerCase());
    if (existingIdx !== -1) {
        inMemoryPapers[existingIdx] = paperObj;
    } else {
        inMemoryPapers.push(paperObj);
    }
    inMemoryActivePaperId = paperObj.id;

    // Send directly to Google Apps Script
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
                    title: paperObj.title,
                    subject: paperObj.subject,
                    totalQuestions: paperObj.totalQuestions,
                    maxMarks: paperObj.maxMarks,
                    sections: paperObj.sections,
                    answerKey: paperObj.answerKey
                }),
                signal: AbortSignal.timeout(18000)
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
        paper: paperObj,
        cloudSynced,
        syncError
    };
}

// Fetch single paper by title from sheet
async function fetchPaperFromSheet(rawUrl, paperTitle = null) {
    const targetUrl = (rawUrl || getEnvUrl() || '').trim();
    if (!targetUrl || !targetUrl.includes('script.google.com/macros/s/')) {
        throw new Error('Google Sheet deployment_url is not set in .env.');
    }

    let fetchEndpoint = targetUrl;
    if (paperTitle) {
        const sep = fetchEndpoint.includes('?') ? '&' : '?';
        fetchEndpoint += `${sep}paperTitle=${encodeURIComponent(paperTitle)}`;
    }

    const res = await fetch(fetchEndpoint, {
        headers: { 'User-Agent': 'OMR-Ordinary-Checker/1.0' },
        signal: AbortSignal.timeout(12000)
    });

    if (!res.ok) {
        throw new Error(`Google Apps Script returned HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    if (!data || !data.success) {
        throw new Error((data && data.error) || 'Failed to fetch paper from Google Apps Script');
    }

    if (data.papers && Array.isArray(data.papers)) {
        inMemoryPapers = data.papers;
        return inMemoryPapers[0];
    }

    const title = data.title || paperTitle || 'Sheet Paper';
    const totalQ = Number(data.totalQuestions) || Object.keys(data.answerKey || {}).length || 180;
    const sections = Array.isArray(data.sections) && data.sections.length > 0 ? data.sections : [];

    const paper = {
        id: title,
        _id: title,
        title: title,
        subject: 'General',
        totalQuestions: totalQ,
        maxMarks: totalQ * 4,
        sections: sections,
        answerKey: data.answerKey || {},
        keySheet: 'Paper - ' + title,
        resultsSheet: 'Results - ' + title
    };

    const existingIdx = inMemoryPapers.findIndex(p => p.title.toLowerCase() === title.toLowerCase());
    if (existingIdx !== -1) {
        inMemoryPapers[existingIdx] = paper;
    } else {
        inMemoryPapers.push(paper);
    }
    inMemoryActivePaperId = paper.id;

    return paper;
}

// Append student's result to that paper's results sheet tab in Google Sheets
async function saveResultToSheet(payload, overrideUrl = null) {
    const targetUrl = (overrideUrl || getEnvUrl() || '').trim();
    if (!targetUrl || !targetUrl.includes('script.google.com/macros/s/')) {
        throw new Error('Google Sheet deployment_url is not set in .env.');
    }

    const paper = getPaperById(payload.paperId);
    const paperTitle = String(payload.paperTitle || (paper && paper.title) || '').trim();

    const studentName = String(payload.studentName || 'Anonymous Student').trim();
    const rollNumber = String(payload.rollNumber || '-').trim();
    const totalMarks = Number(payload.totalMarks !== undefined ? payload.totalMarks : (payload.score || 0));
    const maxMarks = Number(payload.maxMarks || ((paper ? paper.totalQuestions : 180) * 4));
    const sectionMarks = payload.sectionMarks || {};

    const postBody = {
        action: 'saveResult',
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
        signal: AbortSignal.timeout(18000)
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
    syncPapersFromSheet,
    getAllPapers,
    getPaperById,
    getActiveConfig,
    setActivePaper,
    deletePaper,
    createOrUpdatePaper,
    fetchPaperFromSheet,
    saveResultToSheet
};
