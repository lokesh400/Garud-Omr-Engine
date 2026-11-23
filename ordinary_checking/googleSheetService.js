// Service to fetch Paper / Answer Key and submit evaluation results to Google Sheets

let activeSheetConfig = {
    url: '',
    title: 'Ordinary Assessment',
    totalQuestions: 180,
    sections: [
        { name: 'Physics', from: 1, to: 45, maxMarks: 180 },
        { name: 'Chemistry', from: 46, to: 90, maxMarks: 180 },
        { name: 'Botany', from: 91, to: 135, maxMarks: 180 },
        { name: 'Zoology', from: 136, to: 180, maxMarks: 180 }
    ],
    answerKey: {}
};

function getActiveConfig() {
    return activeSheetConfig;
}

function setActiveConfig(config) {
    activeSheetConfig = { ...activeSheetConfig, ...config };
    return activeSheetConfig;
}

// Extract Sheet ID from a standard Google Sheets sharing URL
function extractGoogleSheetId(url) {
    if (!url) return null;
    const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
}

// Fetch paper details & answer key from Google Sheet
async function fetchPaperFromSheet(rawUrl) {
    const targetUrl = (rawUrl || activeSheetConfig.url || '').trim();
    if (!targetUrl) {
        throw new Error('Google Sheet or Web App URL is required');
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

        const totalQ = Number(data.totalQuestions) || Object.keys(data.answerKey || {}).length || 180;
        const sections = Array.isArray(data.sections) && data.sections.length > 0 ? data.sections : [
            { name: 'Physics', from: 1, to: Math.min(45, totalQ) },
            { name: 'Chemistry', from: 46, to: Math.min(90, totalQ) },
            { name: 'Botany', from: 91, to: Math.min(135, totalQ) },
            { name: 'Zoology', from: 136, to: Math.min(180, totalQ) }
        ];

        activeSheetConfig = {
            url: targetUrl,
            title: data.title || 'Ordinary Assessment',
            totalQuestions: totalQ,
            answerKey: data.answerKey || {},
            sections: sections
        };

        return activeSheetConfig;
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
            throw new Error(`Could not access Google Sheet. Please make sure the sheet is shared as "Anyone with link can view" or use the Apps Script Web App URL.`);
        }

        const csvText = await res.text();
        const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

        const answerKey = {};
        const sectionMap = {};
        const sections = [];

        // Parse CSV lines
        lines.forEach((line, idx) => {
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
        activeSheetConfig = {
            url: targetUrl,
            title: `Assessment (${sheetId.slice(0, 6)}...)`,
            totalQuestions: totalQ,
            answerKey: answerKey,
            sections: sections.length > 0 ? sections : [
                { name: 'Physics', from: 1, to: Math.min(45, totalQ) },
                { name: 'Chemistry', from: 46, to: Math.min(90, totalQ) },
                { name: 'Botany', from: 91, to: Math.min(135, totalQ) },
                { name: 'Zoology', from: 136, to: Math.min(180, totalQ) }
            ]
        };

        return activeSheetConfig;
    }

    throw new Error('Invalid Google Sheet URL format. Please provide a Google Apps Script Web App URL or Google Spreadsheet link.');
}

// Append student's section marks & total marks to the Google Sheet
async function saveResultToSheet(payload, overrideUrl = null) {
    const targetUrl = (overrideUrl || activeSheetConfig.url || '').trim();
    if (!targetUrl) {
        throw new Error('Google Sheet / Apps Script Web App URL is not configured. Please set it in Setup.');
    }

    if (!targetUrl.includes('script.google.com/macros/s/')) {
        throw new Error('To record results into Google Sheets, please provide a Google Apps Script Web App URL in Setup.');
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
    getActiveConfig,
    setActiveConfig,
    fetchPaperFromSheet,
    saveResultToSheet
};
