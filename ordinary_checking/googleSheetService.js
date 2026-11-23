const fs = require('fs');
const path = require('path');

const PAPER_STORE_PATH = path.join(__dirname, 'active_paper.json');

function getEnvUrl() {
    return (
        process.env.deployment_url ||
        process.env.DEPLOYMENT_URL ||
        process.env.GOOGLE_SHEET_APP_URL ||
        process.env.ORDINARY_SHEET_URL ||
        ''
    ).trim();
}

// Default initial paper configuration
let activeSheetConfig = {
    url: getEnvUrl(),
    title: 'Ordinary NEET Mock Test',
    subject: 'Physics, Chemistry, Biology',
    totalQuestions: 180,
    maxMarks: 720,
    sections: [
        { name: 'Physics', from: 1, to: 45, maxMarks: 180 },
        { name: 'Chemistry', from: 46, to: 90, maxMarks: 180 },
        { name: 'Botany', from: 91, to: 135, maxMarks: 180 },
        { name: 'Zoology', from: 136, to: 180, maxMarks: 180 }
    ],
    answerKey: {}
};

// Load saved local paper if exists
function loadLocalPaper() {
    try {
        if (fs.existsSync(PAPER_STORE_PATH)) {
            const raw = fs.readFileSync(PAPER_STORE_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                activeSheetConfig = {
                    ...activeSheetConfig,
                    ...parsed,
                    url: getEnvUrl() || parsed.url || activeSheetConfig.url
                };
            }
        }
    } catch (e) {
        console.warn('[Ordinary Checker] Notice loading local paper cache:', e.message);
    }
}
loadLocalPaper();

function getActiveConfig() {
    if (!activeSheetConfig.url) {
        activeSheetConfig.url = getEnvUrl();
    }
    return activeSheetConfig;
}

function setActiveConfig(config) {
    activeSheetConfig = { ...activeSheetConfig, ...config };
    try {
        fs.writeFileSync(PAPER_STORE_PATH, JSON.stringify(activeSheetConfig, null, 2), 'utf8');
    } catch (e) { }
    return activeSheetConfig;
}

// Extract Sheet ID from a standard Google Sheets sharing URL
function extractGoogleSheetId(url) {
    if (!url) return null;
    const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
}

// Create or update a paper and sync to Google Sheet
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

    const updatedConfig = {
        ...activeSheetConfig,
        title: String(paperData.title || 'Ordinary Assessment').trim(),
        subject: String(paperData.subject || 'General').trim(),
        totalQuestions: totalQ,
        maxMarks: maxM,
        sections: sections,
        answerKey: paperData.answerKey || {},
        updatedAt: new Date().toISOString()
    };

    setActiveConfig(updatedConfig);

    // Push to Google Apps Script if URL available
    const targetUrl = (updatedConfig.url || getEnvUrl() || '').trim();
    let cloudSynced = false;
    let syncError = null;

    if (targetUrl && targetUrl.includes('script.google.com/macros/s/')) {
        try {
            const res = await fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'savePaper',
                    title: updatedConfig.title,
                    subject: updatedConfig.subject,
                    totalQuestions: updatedConfig.totalQuestions,
                    sections: updatedConfig.sections,
                    answerKey: updatedConfig.answerKey
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
        paper: updatedConfig,
        cloudSynced,
        syncError
    };
}

// Fetch paper details & answer key from Google Sheet
async function fetchPaperFromSheet(rawUrl) {
    const targetUrl = (rawUrl || getEnvUrl() || activeSheetConfig.url || '').trim();
    if (!targetUrl) {
        throw new Error('Google Sheet or Web App URL is required (set deployment_url in .env)');
    }

    // 1. Google Apps Script Web App Deployment (Preferred & Direct JSON API)
    if (targetUrl.includes('script.google.com/macros/s/')) {
        const res = await fetch(targetUrl, {
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

        const totalQ = Number(data.totalQuestions) || Object.keys(data.answerKey || {}).length || activeSheetConfig.totalQuestions || 180;
        const sections = Array.isArray(data.sections) && data.sections.length > 0 ? data.sections : activeSheetConfig.sections;

        const updated = {
            ...activeSheetConfig,
            url: targetUrl,
            title: (data.title && data.title !== 'AnswerKey') ? data.title : (activeSheetConfig.title || 'Ordinary Assessment'),
            totalQuestions: totalQ,
            answerKey: (data.answerKey && Object.keys(data.answerKey).length > 0) ? data.answerKey : activeSheetConfig.answerKey,
            sections: sections
        };

        setActiveConfig(updated);
        return updated;
    }

    // 2. Direct Google Spreadsheet Link (Public CSV Export of "AnswerKey" Tab)
    const sheetId = extractGoogleSheetId(targetUrl);
    if (sheetId) {
        const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=AnswerKey`;
        const res = await fetch(csvUrl, {
            headers: { 'User-Agent': 'OMR-Ordinary-Checker/1.0' },
            signal: AbortSignal.timeout(10000)
        });

        if (!res.ok) {
            throw new Error(`Could not access Google Sheet. Please make sure the sheet is shared as "Anyone with link can view".`);
        }

        const csvText = await res.text();
        const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

        const answerKey = {};
        const sectionMap = {};
        const sections = [];

        lines.forEach((line) => {
            const cols = line.split(',').map(c => c.replace(/^["']|["']$/g, '').trim());
            const qNum = parseInt(cols[0], 10);
            const ans = String(cols[1] || '').trim().toUpperCase();
            const secName = String(cols[2] || '').trim() || 'Section 1';

            if (!isNaN(qNum) && qNum > 0 && ans) {
                answerKey[String(qNum)] = ans;
                if (!sectionMap[secName]) {
                    sectionMap[secName] = { name: secName, from: qNum, to: qNum };
                    sections.push(sectionMap[secName]);
                } else {
                    sectionMap[secName].to = Math.max(sectionMap[secName].to, qNum);
                }
            }
        });

        const totalQ = Object.keys(answerKey).length || 180;
        const updated = {
            ...activeSheetConfig,
            url: targetUrl,
            title: `Assessment (${sheetId.slice(0, 6)}...)`,
            totalQuestions: totalQ,
            answerKey: answerKey,
            sections: sections.length > 0 ? sections : activeSheetConfig.sections
        };

        setActiveConfig(updated);
        return updated;
    }

    throw new Error('Invalid Google Sheet URL format. Please provide a Google Apps Script Web App URL.');
}

// Append student's section marks & total marks to the Google Sheet
async function saveResultToSheet(payload, overrideUrl = null) {
    const targetUrl = (overrideUrl || getEnvUrl() || activeSheetConfig.url || '').trim();
    if (!targetUrl) {
        throw new Error('Google Sheet deployment_url is not set in .env or configuration.');
    }

    if (!targetUrl.includes('script.google.com/macros/s/')) {
        throw new Error('Please ensure deployment_url in .env is a valid Google Apps Script Web App URL.');
    }

    const studentName = String(payload.studentName || 'Anonymous Student').trim();
    const rollNumber = String(payload.rollNumber || '-').trim();
    const totalMarks = Number(payload.totalMarks !== undefined ? payload.totalMarks : (payload.score || 0));
    const maxMarks = Number(payload.maxMarks || (activeSheetConfig.totalQuestions * 4));
    const sectionMarks = payload.sectionMarks || {};

    const postBody = {
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
        message: (json && json.message) || `Result saved for ${studentName}`,
        studentName,
        totalMarks
    };
}

module.exports = {
    getEnvUrl,
    getActiveConfig,
    setActiveConfig,
    createOrUpdatePaper,
    fetchPaperFromSheet,
    saveResultToSheet
};
