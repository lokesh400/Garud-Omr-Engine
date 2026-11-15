/**
 * High-Precision OMR Image Extraction & Computer Vision Evaluation Engine
 * 
 * Extracts student OMR sheets from Cloudinary (or local storage), runs the full
 * moat-sampling bubble detection algorithm on the decoded pixels, evaluates
 * responses against the official answer key, preserves Section B numerical answers,
 * and regenerates the complete submission breakdown and subject scores.
 */

const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

// Grid Geometry Ratios for 200-Question OMR Standard Form
const U_START = 0.061846;
const V_START = 0.256331;
const U_BUBBLE_STEP = 0.028042;
const V_ROW_STEP = 0.018233;
const U_COL_STEP = 0.201332;
const QUESTIONS_PER_COL = 40;
const OPTIONS = ['A', 'B', 'C', 'D'];

// Roll Number Grid Geometry Ratios
const U_ROLL_START = 0.619879;
const V_ROLL_START = 0.058644;
const U_ROLL_COL_STEP = 0.026640;
const V_ROLL_ROW_STEP = 0.018233;

/**
 * Build 1-based key lookup dictionary from paper
 */
function buildKeyLookup(paper) {
    const keyLookup = {};
    if (!paper) return keyLookup;
    const totalQ = paper.total_questions || paper.numQuestions || 50;

    if (Array.isArray(paper.answer_key) && paper.answer_key.length > 0) {
        paper.answer_key.forEach((ans, i) => {
            if (ans && typeof ans === 'string' && ans.trim() !== '') {
                keyLookup[i + 1] = ans.trim().toUpperCase();
            }
        });
    } else if (paper.answerKey) {
        for (let i = 1; i <= totalQ; i++) {
            const k = (typeof paper.answerKey.get === 'function')
                ? paper.answerKey.get(String(i))
                : paper.answerKey[String(i)];
            if (k && typeof k === 'string' && k.trim() !== '') {
                keyLookup[i] = k.trim().toUpperCase();
            }
        }
    }
    return keyLookup;
}

/**
 * Core image buffer evaluation using ring-moat computer vision bubble detection
 */
function evaluateOmrBuffer(imageBuffer, paper, existingSubmission = null) {
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
        throw new Error('Invalid image buffer provided to evaluateOmrBuffer');
    }

    // Decode JPEG image
    const imgData = jpeg.decode(imageBuffer, { useTArray: true, formatAsRGBA: true });
    const W = imgData.width;
    const H = imgData.height;
    const pixels = imgData.data;
    const scale = W / 1000.0;

    function getGray(x, y) {
        x = Math.max(0, Math.min(W - 1, Math.round(x)));
        y = Math.max(0, Math.min(H - 1, Math.round(y)));
        const idx = (y * W + x) * 4;
        return 0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2];
    }

    function sampleDisk(cx, cy, r) {
        let sum = 0, count = 0;
        const r2 = r * r;
        const ir = Math.ceil(r);
        for (let dy = -ir; dy <= ir; dy++) {
            for (let dx = -ir; dx <= ir; dx++) {
                if (dx * dx + dy * dy <= r2) {
                    sum += getGray(Math.round(cx + dx), Math.round(cy + dy));
                    count++;
                }
            }
        }
        return count > 0 ? (sum / count) : 255;
    }

    function sampleBubbleFeatures(nominalX, nominalY, paperVal) {
        let midSum = 0, midCount = 0, darkMidCount = 0;
        let fullSum = 0, fullCount = 0;
        const maxR = 5.0 * scale;
        const innerR = 2.2 * scale;
        const ir = Math.ceil(maxR);

        for (let dy = -ir; dy <= ir; dy++) {
            for (let dx = -ir; dx <= ir; dx++) {
                const d2 = dx * dx + dy * dy;
                const d = Math.sqrt(d2);
                if (d > maxR) continue;

                const g = getGray(Math.round(nominalX + dx), Math.round(nominalY + dy));
                fullSum += g;
                fullCount++;

                if (d >= innerR && d <= maxR) {
                    midSum += g;
                    midCount++;
                    if (g < (paperVal - 25)) darkMidCount++;
                }
            }
        }

        if (midCount === 0 || fullCount === 0) {
            return { midDarkness: 0, fullDarkness: 0, midDarkRatio: 0, fillScore: 0 };
        }

        const midMean = midSum / midCount;
        const fullMean = fullSum / fullCount;
        const midDarkness = Math.max(0, paperVal - midMean);
        const fullDarkness = Math.max(0, paperVal - fullMean);
        const midDarkRatio = darkMidCount / midCount;
        const fillScore = midDarkness * 0.70 + fullDarkness * 0.30;

        return { midDarkness, fullDarkness, midDarkRatio, fillScore };
    }

    // Sample question bubbles for question index q (1-based physical OMR question number)
    function sampleQuestionBubbles(q) {
        const col = Math.floor((q - 1) / QUESTIONS_PER_COL);
        const row = (q - 1) % QUESTIONS_PER_COL;
        const rowY = (V_START + row * V_ROW_STEP) * H;
        const colX = (U_START + col * U_COL_STEP) * W;

        const optD_X = colX + 3 * U_BUBBLE_STEP * W;
        const gutterSampleX = Math.min(W - 14 * scale, optD_X + 16 * scale);
        const paperVal1 = sampleDisk(gutterSampleX, rowY, 3.5 * scale);
        const paperVal2 = sampleDisk(colX + U_BUBBLE_STEP * W, Math.max(10, rowY - 10 * scale), 3.5 * scale);
        const paperVal = Math.max(paperVal1, paperVal2);

        let bubbleStats = [];
        for (let b = 0; b < 4; b++) {
            const bubbleX = colX + (b * U_BUBBLE_STEP) * W;
            const sample = sampleBubbleFeatures(bubbleX, rowY, paperVal);
            bubbleStats.push({ opt: OPTIONS[b], ...sample });
        }

        const sortedAsc = [...bubbleStats].sort((a, b) => a.fillScore - b.fillScore);
        const rowBase = (sortedAsc[0].fillScore + sortedAsc[1].fillScore) / 2;
        const sortedDesc = [...bubbleStats].sort((a, b) => b.fillScore - a.fillScore);
        const maxOption = sortedDesc[0];

        const isRowBlank = (maxOption.fillScore < 34 && maxOption.midDarkness < 30 && maxOption.midDarkRatio < 0.35);

        function isOptionFilled(s) {
            if (isRowBlank) return false;
            const contrast = s.fillScore - rowBase;
            if (s.fillScore >= 65 && s.midDarkness >= 45 && s.midDarkRatio >= 0.40) return true;
            if (s.fillScore >= 48 && s.midDarkRatio >= 0.35 && contrast >= 20) return true;
            if (s.midDarkness >= 30 && s.midDarkRatio >= 0.42 && s.fillScore >= 35 && contrast >= 18) return true;
            if (s.midDarkness >= 55 && s.midDarkRatio >= 0.55 && s.fullDarkness >= 50 && s.fillScore >= 55) return true;
            return false;
        }

        const filled = isRowBlank ? [] : bubbleStats.filter(b => isOptionFilled(b));
        return filled.map(b => b.opt);
    }

    // Detect 8-digit roll number from sheet
    let detectedRoll = '';
    for (let c = 0; c < 8; c++) {
        const colX = (U_ROLL_START + c * U_ROLL_COL_STEP) * W;
        const p1 = sampleDisk(colX - 8 * scale, (V_ROLL_START - 0.02) * H, 3.5 * scale);
        const p2 = sampleDisk(colX + 8 * scale, (V_ROLL_START - 0.02) * H, 3.5 * scale);
        const rollPaperVal = Math.max(p1, p2);

        let colStats = [];
        for (let d = 0; d < 10; d++) {
            const rowY = (V_ROLL_START + d * V_ROLL_ROW_STEP) * H;
            const b = sampleBubbleFeatures(colX, rowY, rollPaperVal);
            colStats.push({ digit: d, ...b });
        }

        const sortedAsc = [...colStats].sort((a, b) => a.fillScore - b.fillScore);
        const colBase = (sortedAsc[0].fillScore + sortedAsc[1].fillScore + sortedAsc[2].fillScore) / 3;

        colStats.sort((a, b) => b.fillScore - a.fillScore);
        const top1 = colStats[0];
        const top2 = colStats[1];

        const top1Contrast = top1.fillScore - colBase;
        let isColFilled = false;
        if (top1.midDarkness >= 32 && top1Contrast >= 18) {
            if (top1.fillScore - top2.fillScore >= 16 || top1Contrast >= 24) {
                isColFilled = true;
            }
        }
        detectedRoll += isColFilled ? top1.digit.toString() : '-';
    }

    // Determine final student roll number
    let finalRoll = (existingSubmission && (existingSubmission.rollnumber || existingSubmission.rollNumber)) || '';
    if (!finalRoll || finalRoll === 'UNKNOWN' || finalRoll.includes('-')) {
        if (detectedRoll && !detectedRoll.includes('-')) {
            finalRoll = detectedRoll;
        }
    }
    if (!finalRoll) {
        finalRoll = detectedRoll || 'UNKNOWN';
    }

    const keyLookup = buildKeyLookup(paper);
    const isJEE = (paper.exam_type === 'jee' || (existingSubmission && existingSubmission.examType === 'jee'));

    // ==========================================
    // JEE MAINS EVALUATION (75 Questions)
    // ==========================================
    if (isJEE) {
        const responsesArray = new Array(100).fill(null);
        const breakdown = [];

        // Preserve existing Section B numerical values and scores if present
        const existingNumScores = (existingSubmission && existingSubmission.numericalScores) || {};
        const numScores = {
            phy: Array.isArray(existingNumScores.phy) ? [...existingNumScores.phy] : [0, 0, 0, 0, 0],
            chem: Array.isArray(existingNumScores.chem) ? [...existingNumScores.chem] : [0, 0, 0, 0, 0],
            math: Array.isArray(existingNumScores.math) ? [...existingNumScores.math] : [0, 0, 0, 0, 0]
        };

        const existingBreakdownMap = {};
        if (existingSubmission && Array.isArray(existingSubmission.breakdown)) {
            existingSubmission.breakdown.forEach(item => {
                if (item && item.isNumerical) {
                    existingBreakdownMap[item.displayQ || item.q] = item;
                }
            });
        }

        // 1. PHYSICS (Q1..25)
        let phyScore = 0, phyCorrect = 0, phyWrong = 0, phyBlank = 0;
        for (let i = 0; i < 20; i++) {
            const omrQ = i + 1;
            const dispQ = i + 1;
            const filled = sampleQuestionBubbles(omrQ);
            const markedStr = filled.length > 0 ? filled.join(',') : null;
            if (markedStr) responsesArray[omrQ - 1] = markedStr;

            const key = (keyLookup[omrQ] || keyLookup[dispQ] || '').trim().toUpperCase();
            let verdict = 'blank', marks = '0';
            if (!markedStr) {
                verdict = 'blank'; marks = '0'; phyBlank++;
            } else if (filled.length > 1) {
                verdict = 'multiple'; marks = '-1'; phyWrong++; phyScore -= 1;
            } else if (key && markedStr === key) {
                verdict = 'correct'; marks = '+4'; phyCorrect++; phyScore += 4;
            } else if (key) {
                verdict = 'wrong'; marks = '-1'; phyWrong++; phyScore -= 1;
            } else {
                verdict = 'marked'; marks = '+4'; phyCorrect++; phyScore += 4;
            }

            breakdown.push({
                q: dispQ,
                displayQ: dispQ,
                omrQ: omrQ,
                subject: 'Physics',
                subKey: 'phy',
                section: 'A',
                marked: markedStr || '-',
                correctKey: key || '-',
                verdict,
                marks,
                isNumerical: false
            });
        }

        // Physics Section B (Numerical Q21..25)
        for (let i = 0; i < 5; i++) {
            const dispQ = 21 + i;
            const nvqMark = Number(numScores.phy[i] || 0);
            const exist = existingBreakdownMap[dispQ];
            let verdict = 'blank', marks = '0';
            if (nvqMark === 4) { verdict = 'correct'; marks = '+4'; }
            else if (nvqMark === -1) { verdict = 'wrong'; marks = '-1'; }
            else { verdict = 'blank'; marks = '0'; }

            breakdown.push({
                q: dispQ,
                displayQ: dispQ,
                omrQ: null,
                subject: 'Physics',
                subKey: 'phy',
                section: 'B',
                marked: (exist && exist.marked) || '-',
                correctKey: (exist && exist.correctKey) || '-',
                verdict: (exist && exist.verdict) || verdict,
                marks: marks,
                isNumerical: true
            });
        }

        // 2. CHEMISTRY (Q26..50)
        let chemScore = 0, chemCorrect = 0, chemWrong = 0, chemBlank = 0;
        for (let i = 0; i < 20; i++) {
            const omrQ = 41 + i;
            const dispQ = 26 + i;
            const filled = sampleQuestionBubbles(omrQ);
            const markedStr = filled.length > 0 ? filled.join(',') : null;
            if (markedStr) responsesArray[omrQ - 1] = markedStr;

            const key = (keyLookup[omrQ] || keyLookup[dispQ] || '').trim().toUpperCase();
            let verdict = 'blank', marks = '0';
            if (!markedStr) {
                verdict = 'blank'; marks = '0'; chemBlank++;
            } else if (filled.length > 1) {
                verdict = 'multiple'; marks = '-1'; chemWrong++; chemScore -= 1;
            } else if (key && markedStr === key) {
                verdict = 'correct'; marks = '+4'; chemCorrect++; chemScore += 4;
            } else if (key) {
                verdict = 'wrong'; marks = '-1'; chemWrong++; chemScore -= 1;
            } else {
                verdict = 'marked'; marks = '+4'; chemCorrect++; chemScore += 4;
            }

            breakdown.push({
                q: dispQ,
                displayQ: dispQ,
                omrQ: omrQ,
                subject: 'Chemistry',
                subKey: 'chem',
                section: 'A',
                marked: markedStr || '-',
                correctKey: key || '-',
                verdict,
                marks,
                isNumerical: false
            });
        }

        // Chemistry Section B (Numerical Q46..50)
        for (let i = 0; i < 5; i++) {
            const dispQ = 46 + i;
            const nvqMark = Number(numScores.chem[i] || 0);
            const exist = existingBreakdownMap[dispQ];
            let verdict = 'blank', marks = '0';
            if (nvqMark === 4) { verdict = 'correct'; marks = '+4'; }
            else if (nvqMark === -1) { verdict = 'wrong'; marks = '-1'; }
            else { verdict = 'blank'; marks = '0'; }

            breakdown.push({
                q: dispQ,
                displayQ: dispQ,
                omrQ: null,
                subject: 'Chemistry',
                subKey: 'chem',
                section: 'B',
                marked: (exist && exist.marked) || '-',
                correctKey: (exist && exist.correctKey) || '-',
                verdict: (exist && exist.verdict) || verdict,
                marks: marks,
                isNumerical: true
            });
        }

        // 3. MATHEMATICS (Q51..75)
        let mathScore = 0, mathCorrect = 0, mathWrong = 0, mathBlank = 0;
        for (let i = 0; i < 20; i++) {
            const omrQ = 81 + i;
            const dispQ = 51 + i;
            const filled = sampleQuestionBubbles(omrQ);
            const markedStr = filled.length > 0 ? filled.join(',') : null;
            if (markedStr) responsesArray[omrQ - 1] = markedStr;

            const key = (keyLookup[omrQ] || keyLookup[dispQ] || '').trim().toUpperCase();
            let verdict = 'blank', marks = '0';
            if (!markedStr) {
                verdict = 'blank'; marks = '0'; mathBlank++;
            } else if (filled.length > 1) {
                verdict = 'multiple'; marks = '-1'; mathWrong++; mathScore -= 1;
            } else if (key && markedStr === key) {
                verdict = 'correct'; marks = '+4'; mathCorrect++; mathScore += 4;
            } else if (key) {
                verdict = 'wrong'; marks = '-1'; mathWrong++; mathScore -= 1;
            } else {
                verdict = 'marked'; marks = '+4'; mathCorrect++; mathScore += 4;
            }

            breakdown.push({
                q: dispQ,
                displayQ: dispQ,
                omrQ: omrQ,
                subject: 'Mathematics',
                subKey: 'math',
                section: 'A',
                marked: markedStr || '-',
                correctKey: key || '-',
                verdict,
                marks,
                isNumerical: false
            });
        }

        // Mathematics Section B (Numerical Q71..75)
        for (let i = 0; i < 5; i++) {
            const dispQ = 71 + i;
            const nvqMark = Number(numScores.math[i] || 0);
            const exist = existingBreakdownMap[dispQ];
            let verdict = 'blank', marks = '0';
            if (nvqMark === 4) { verdict = 'correct'; marks = '+4'; }
            else if (nvqMark === -1) { verdict = 'wrong'; marks = '-1'; }
            else { verdict = 'blank'; marks = '0'; }

            breakdown.push({
                q: dispQ,
                displayQ: dispQ,
                omrQ: null,
                subject: 'Mathematics',
                subKey: 'math',
                section: 'B',
                marked: (exist && exist.marked) || '-',
                correctKey: (exist && exist.correctKey) || '-',
                verdict: (exist && exist.verdict) || verdict,
                marks: marks,
                isNumerical: true
            });
        }

        const sumArr = arr => Array.isArray(arr) ? arr.reduce((a, b) => a + Number(b || 0), 0) : 0;
        const phyNvq = sumArr(numScores.phy);
        const chemNvq = sumArr(numScores.chem);
        const mathNvq = sumArr(numScores.math);

        let nvqCorrect = 0, nvqWrong = 0, nvqBlank = 0;
        ['phy', 'chem', 'math'].forEach(subKey => {
            (numScores[subKey] || []).forEach(v => {
                const n = Number(v);
                if (n === 4) nvqCorrect++;
                else if (n === -1) nvqWrong++;
                else nvqBlank++;
            });
        });

        const totalScore = phyScore + phyNvq + chemScore + chemNvq + mathScore + mathNvq;
        const totalCorrect = phyCorrect + chemCorrect + mathCorrect + nvqCorrect;
        const totalWrong = phyWrong + chemWrong + mathWrong + nvqWrong;
        const totalBlank = phyBlank + chemBlank + mathBlank + nvqBlank;
        const maxMarks = 300;
        const percentage = maxMarks > 0 ? Math.round((totalScore / maxMarks) * 100) : 0;

        const mcqSubjectScores = {
            phy: { score: phyScore, correct: phyCorrect, wrong: phyWrong, blank: phyBlank },
            chem: { score: chemScore, correct: chemCorrect, wrong: chemWrong, blank: chemBlank },
            math: { score: mathScore, correct: mathCorrect, wrong: mathWrong, blank: mathBlank }
        };

        return {
            rollnumber: finalRoll,
            score: totalScore,
            totalQuestions: 75,
            percentage,
            maxMarks,
            correctCount: totalCorrect,
            wrongCount: totalWrong,
            blankCount: totalBlank,
            examType: 'jee',
            responses: responsesArray,
            breakdown,
            numericalScores: numScores,
            mcqSubjectScores
        };
    }

    // ==========================================
    // STANDARD EXAM EVALUATION (1..total_questions)
    // ==========================================
    const totalQ = paper.total_questions || paper.numQuestions || 50;
    const responsesArray = new Array(totalQ).fill(null);
    const breakdown = [];
    let score = 0, correctCount = 0, wrongCount = 0, blankCount = 0;

    for (let q = 1; q <= totalQ; q++) {
        const filled = sampleQuestionBubbles(q);
        const markedStr = filled.length > 0 ? filled.join(',') : null;
        if (markedStr) responsesArray[q - 1] = markedStr;

        const key = (keyLookup[q] || '').trim().toUpperCase();
        let verdict = 'blank', marks = '0';
        if (!markedStr) {
            verdict = 'blank'; marks = '0'; blankCount++;
        } else if (filled.length > 1) {
            verdict = 'multiple'; marks = '-1'; wrongCount++;
        } else if (key && markedStr === key) {
            verdict = 'correct'; marks = '+1'; score++; correctCount++;
        } else if (key) {
            verdict = 'wrong'; marks = '-1'; wrongCount++;
        } else {
            verdict = 'marked'; marks = '+1'; score++; correctCount++;
        }

        breakdown.push({
            q,
            displayQ: q,
            omrQ: q,
            marked: markedStr || '-',
            correctKey: key || '-',
            verdict,
            marks
        });
    }

    const maxMarks = paper.max_marks || (totalQ * 4);
    const percentage = totalQ > 0 ? Math.round((correctCount / totalQ) * 100) : 0;

    return {
        rollnumber: finalRoll,
        score,
        totalQuestions: totalQ,
        percentage,
        maxMarks,
        correctCount,
        wrongCount,
        blankCount,
        examType: 'standard',
        responses: responsesArray,
        breakdown,
        numericalScores: {},
        mcqSubjectScores: {}
    };
}

/**
 * Fetch image buffer from Cloudinary URL or local file path
 */
async function fetchSheetImageBuffer(imageUrl) {
    if (!imageUrl) {
        throw new Error('Image URL is missing on submission');
    }

    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);
        try {
            const res = await fetch(imageUrl, { signal: controller.signal });
            if (!res.ok) {
                throw new Error(`Failed to download image from Cloudinary (HTTP ${res.status}: ${res.statusText})`);
            }
            const arrayBuf = await res.arrayBuffer();
            return Buffer.from(arrayBuf);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    // Local file fallback
    const cleanPath = imageUrl.startsWith('/uploads/') ? imageUrl.slice('/uploads/'.length) : imageUrl;
    const localPath = path.join(__dirname, '..', 'public', 'uploads', cleanPath);
    if (fs.existsSync(localPath)) {
        return fs.readFileSync(localPath);
    }

    throw new Error(`Sheet image file not found at: ${imageUrl}`);
}

/**
 * Download sheet from Cloudinary and completely recheck submission
 */
async function recheckSubmissionFromCloudinary(submission, paper) {
    const imgUrl = submission.cloudinary_image_url || submission.omrImageUrl;
    if (!imgUrl) {
        throw new Error(`Submission ${submission._id} is missing Cloudinary image URL`);
    }

    const imageBuffer = await fetchSheetImageBuffer(imgUrl);
    const result = evaluateOmrBuffer(imageBuffer, paper, submission);

    // Apply updates to the submission document
    submission.score = result.score;
    submission.totalQuestions = result.totalQuestions;
    submission.percentage = result.percentage;
    submission.maxMarks = result.maxMarks;
    submission.correctCount = result.correctCount;
    submission.wrongCount = result.wrongCount;
    submission.blankCount = result.blankCount;
    submission.examType = result.examType;
    submission.responses = result.responses;
    submission.breakdown = result.breakdown;
    submission.numericalScores = result.numericalScores;
    submission.mcqSubjectScores = result.mcqSubjectScores;

    if (result.rollnumber && result.rollnumber !== 'UNKNOWN' && !result.rollnumber.includes('-')) {
        submission.rollnumber = result.rollnumber;
    }

    await submission.save();
    return { submission, evaluated: result };
}

module.exports = {
    evaluateOmrBuffer,
    fetchSheetImageBuffer,
    recheckSubmissionFromCloudinary,
    buildKeyLookup
};
