const mongoose = require('mongoose');
const fs = require('fs');
const Paper = require('../models/Paper');
const Submission = require('../models/Submission');
const User = require('../models/User');
const Folder = require('../models/Folder');
const { evaluateQuestionVerdict } = require('../utils/omrEvaluator');
const { deleteOmrSheet } = require('../utils/cloudinaryPool');
const { summarizeSections } = require('../utils/resultsExport');

// Helper to convert answer key to object (with XSS script-breakout neutralization)
function getAnswerKeyJson(paper) {
    if (!paper) return '{}';
    const obj = {};
    if (Array.isArray(paper.answer_key) && paper.answer_key.length > 0) {
        paper.answer_key.forEach((val, idx) => {
            if (val) obj[String(idx + 1)] = val;
        });
        return JSON.stringify(obj).replace(/</g, '\\u003c');
    }
    if (paper.answerKey instanceof Map) {
        return JSON.stringify(Object.fromEntries(paper.answerKey)).replace(/</g, '\\u003c');
    }
    if (typeof paper.answerKey === 'object' && paper.answerKey !== null) {
        if (typeof paper.answerKey.toObject === 'function') {
            return JSON.stringify(paper.answerKey.toObject()).replace(/</g, '\\u003c');
        }
        return JSON.stringify(paper.answerKey).replace(/</g, '\\u003c');
    }
    return '{}';
}

// Helper to build 1-based answer key lookup map
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

// Alias for backwards compatibility
const getAnswerKeyLookup = buildKeyLookup;

// Re-evaluate a student's saved responses array against a keyLookup
function evaluateResponsesAgainstKey(responses, keyLookup, totalQ) {
    const resps = Array.isArray(responses) ? responses : [];
    let score = 0;
    let correctCount = 0;
    let wrongCount = 0;
    let blankCount = 0;
    let evaluatedKeyCount = 0;

    for (let q = 1; q <= totalQ; q++) {
        const raw = resps[q - 1];
        const marked = raw ? String(raw).trim().toUpperCase() : '';
        const key = keyLookup[q] ? String(keyLookup[q]).trim().toUpperCase() : '';

        if (key) evaluatedKeyCount++;

        const evalRes = evaluateQuestionVerdict(marked, key, 'standard');
        if (evalRes.isBonus) {
            score += evalRes.scoreDelta;
            correctCount++;
        } else if (evalRes.isBlank) {
            blankCount++;
        } else if (evalRes.isCorrect) {
            score += evalRes.scoreDelta;
            correctCount++;
        } else if (evalRes.isWrong) {
            wrongCount++;
        }
    }

    const denom = evaluatedKeyCount > 0 ? evaluatedKeyCount : totalQ;
    const percentage = denom > 0 ? Math.round((Math.max(0, score) / denom) * 100) : 0;

    return { score, correctCount, wrongCount, blankCount, percentage };
}

function countNvqForSubject(arr) {
    const a = Array.isArray(arr) ? arr : [];
    let corr = 0, wrng = 0, blnk = 0;
    for (let i = 0; i < 5; i++) {
        const n = Number(a[i]);
        if (n === 4) corr++;
        else if (n === -1) wrng++;
        else blnk++;
    }
    return { corr, wrng, blnk, attempted: corr + wrng, marks: (corr * 4) - wrng };
}

// Recalculate and persist scores for all existing submissions of a paper
async function regradePaperSubmissions(paper) {
    if (!paper) return 0;
    const paperIdStr = String(paper._id);
    const submissions = await Submission.find({
        $or: [
            { paper_id: paperIdStr },
            { paper_id: paper._id },
            { paperId: paper._id }
        ]
    });

    if (!submissions || submissions.length === 0) return 0;

    const keyLookup = buildKeyLookup(paper);
    const defaultTotalQ = paper.total_questions || paper.numQuestions || 50;
    const paperMaxMarks = paper.max_marks || (defaultTotalQ * 4);

    const bulkOps = submissions.map(sub => {
        if (sub.examType === 'jee') {
            let phyScore = 0, phyCorrect = 0, phyWrong = 0, phyBlank = 0;
            let chemScore = 0, chemCorrect = 0, chemWrong = 0, chemBlank = 0;
            let mathScore = 0, mathCorrect = 0, mathWrong = 0, mathBlank = 0;

            let updatedBreakdown = [];
            const hasBreakdown = Array.isArray(sub.breakdown) && sub.breakdown.length > 0;

            if (hasBreakdown) {
                updatedBreakdown = sub.breakdown.map(item => {
                    if (!item) return item;
                    if (item.isNumerical) return { ...item };

                    const omrQ = Number(item.omrQ);
                    const dispQ = Number(item.displayQ || item.q);
                    const key = (keyLookup[omrQ] || keyLookup[dispQ] || '').trim().toUpperCase();
                    const marked = (item.marked || '').trim().toUpperCase();

                    const evalRes = evaluateQuestionVerdict(marked, key, 'jee');
                    const verdict = evalRes.verdict;
                    const marks = evalRes.marks;

                    const subKey = item.subKey || (dispQ <= 25 ? 'phy' : (dispQ <= 50 ? 'chem' : 'math'));
                    if (subKey === 'phy') {
                        if (evalRes.isBonus || evalRes.isCorrect) { phyCorrect++; phyScore += 4; }
                        else if (evalRes.isBlank) { phyBlank++; }
                        else if (evalRes.isWrong) { phyWrong++; phyScore -= 1; }
                    } else if (subKey === 'chem') {
                        if (evalRes.isBonus || evalRes.isCorrect) { chemCorrect++; chemScore += 4; }
                        else if (evalRes.isBlank) { chemBlank++; }
                        else if (evalRes.isWrong) { chemWrong++; chemScore -= 1; }
                    } else if (subKey === 'math') {
                        if (evalRes.isBonus || evalRes.isCorrect) { mathCorrect++; mathScore += 4; }
                        else if (evalRes.isBlank) { mathBlank++; }
                        else if (evalRes.isWrong) { mathWrong++; mathScore -= 1; }
                    }

                    return {
                        ...item,
                        key: key || '',
                        verdict,
                        marks
                    };
                });
            } else {
                const resps = Array.isArray(sub.responses) ? sub.responses : [];
                // Physics: strictly physical OMR Q1..20
                for (let q = 1; q <= 20; q++) {
                    const m = (resps[q - 1] || '').trim().toUpperCase();
                    const k = (keyLookup[q] || '').trim().toUpperCase();
                    const evalRes = evaluateQuestionVerdict(m, k, 'jee');
                    if (evalRes.isBonus || evalRes.isCorrect) { phyCorrect++; phyScore += 4; }
                    else if (evalRes.isBlank) { phyBlank++; }
                    else if (evalRes.isWrong) { phyWrong++; phyScore -= 1; }
                }
                // Chemistry: strictly physical OMR Q41..60
                for (let omrQ = 41; omrQ <= 60; omrQ++) {
                    const m = (resps[omrQ - 1] || '').trim().toUpperCase();
                    const k = (keyLookup[omrQ] || keyLookup[26 + (omrQ - 41)] || '').trim().toUpperCase();
                    const evalRes = evaluateQuestionVerdict(m, k, 'jee');
                    if (evalRes.isBonus || evalRes.isCorrect) { chemCorrect++; chemScore += 4; }
                    else if (evalRes.isBlank) { chemBlank++; }
                    else if (evalRes.isWrong) { chemWrong++; chemScore -= 1; }
                }
                // Mathematics: strictly physical OMR Q81..100
                for (let omrQ = 81; omrQ <= 100; omrQ++) {
                    const m = (resps[omrQ - 1] || '').trim().toUpperCase();
                    const k = (keyLookup[omrQ] || keyLookup[51 + (omrQ - 81)] || '').trim().toUpperCase();
                    const evalRes = evaluateQuestionVerdict(m, k, 'jee');
                    if (evalRes.isBonus || evalRes.isCorrect) { mathCorrect++; mathScore += 4; }
                    else if (evalRes.isBlank) { mathBlank++; }
                    else if (evalRes.isWrong) { mathWrong++; mathScore -= 1; }
                }
            }

            const numScores = sub.numericalScores || {};
            const sumArr = arr => Array.isArray(arr) ? arr.reduce((a, b) => a + Number(b || 0), 0) : 0;
            const phyNvq = sumArr(numScores.phy);
            const chemNvq = sumArr(numScores.chem);
            const mathNvq = sumArr(numScores.math);

            let nvqCorrect = 0, nvqWrong = 0, nvqBlank = 0;
            ['phy', 'chem', 'math'].forEach(subKey => {
                const arr = numScores[subKey] || [];
                arr.forEach(val => {
                    const n = Number(val);
                    if (n === 4) nvqCorrect++;
                    else if (n === -1) nvqWrong++;
                    else nvqBlank++;
                });
            });

            const totalScore = (phyScore + phyNvq) + (chemScore + chemNvq) + (mathScore + mathNvq);
            const totalCorrect = phyCorrect + chemCorrect + mathCorrect + nvqCorrect;
            const totalWrong = phyWrong + chemWrong + mathWrong + nvqWrong;
            const totalBlank = phyBlank + chemBlank + mathBlank + nvqBlank;
            const maxM = sub.maxMarks || 300;
            const pct = maxM > 0 ? Math.round((totalScore / maxM) * 100) : 0;

            const phyNvqStats = countNvqForSubject(numScores.phy);
            const chemNvqStats = countNvqForSubject(numScores.chem);
            const mathNvqStats = countNvqForSubject(numScores.math);

            const phyTotalCorr = phyCorrect + phyNvqStats.corr;
            const phyTotalWrng = phyWrong + phyNvqStats.wrng;
            const phyTotalBlnk = phyBlank + phyNvqStats.blnk;
            const phyTotalAtt = phyTotalCorr + phyTotalWrng;

            const chemTotalCorr = chemCorrect + chemNvqStats.corr;
            const chemTotalWrng = chemWrong + chemNvqStats.wrng;
            const chemTotalBlnk = chemBlank + chemNvqStats.blnk;
            const chemTotalAtt = chemTotalCorr + chemTotalWrng;

            const mathTotalCorr = mathCorrect + mathNvqStats.corr;
            const mathTotalWrng = mathWrong + mathNvqStats.wrng;
            const mathTotalBlnk = mathBlank + mathNvqStats.blnk;
            const mathTotalAtt = mathTotalCorr + mathTotalWrng;

            const updatedSectionWise = [
                {
                    sectionName: 'Physics',
                    range: '',
                    correct: phyTotalCorr,
                    wrong: phyTotalWrng,
                    blank: phyTotalBlnk,
                    totalQuestions: 25,
                    attempted: phyTotalAtt,
                    unattempted: phyTotalBlnk,
                    marks: phyScore + phyNvq,
                    maxMarks: 100
                },
                {
                    sectionName: 'Chemistry',
                    range: '',
                    correct: chemTotalCorr,
                    wrong: chemTotalWrng,
                    blank: chemTotalBlnk,
                    totalQuestions: 25,
                    attempted: chemTotalAtt,
                    unattempted: chemTotalBlnk,
                    marks: chemScore + chemNvq,
                    maxMarks: 100
                },
                {
                    sectionName: 'Mathematics',
                    range: '',
                    correct: mathTotalCorr,
                    wrong: mathTotalWrng,
                    blank: mathTotalBlnk,
                    totalQuestions: 25,
                    attempted: mathTotalAtt,
                    unattempted: mathTotalBlnk,
                    marks: mathScore + mathNvq,
                    maxMarks: 100
                }
            ];

            const updatedAllSections = {
                totalMarks: maxM,
                obtainedMarks: totalScore,
                totalQuestions: 75,
                attemptedQuestions: totalCorrect + totalWrong,
                unattemptedQuestions: totalBlank,
                correctCount: totalCorrect,
                wrongCount: totalWrong
            };

            const updatedMcq = {
                phy: { score: phyScore, correct: phyCorrect, wrong: phyWrong, blank: phyBlank },
                chem: { score: chemScore, correct: chemCorrect, wrong: chemWrong, blank: chemBlank },
                math: { score: mathScore, correct: mathCorrect, wrong: mathWrong, blank: mathBlank }
            };

            const updateFields = {
                score: totalScore,
                totalQuestions: 75,
                percentage: pct,
                maxMarks: maxM,
                correctCount: totalCorrect,
                wrongCount: totalWrong,
                blankCount: totalBlank,
                mcqSubjectScores: updatedMcq,
                sectionWise: updatedSectionWise,
                allSectionsSummary: updatedAllSections
            };
            if (hasBreakdown) {
                updateFields.breakdown = updatedBreakdown;
            }

            return {
                updateOne: {
                    filter: { _id: sub._id },
                    update: { $set: updateFields }
                }
            };
        }

        const totalQ = sub.totalQuestions || defaultTotalQ;
        const graded = evaluateResponsesAgainstKey(sub.responses, keyLookup, totalQ);

        return {
            updateOne: {
                filter: { _id: sub._id },
                update: {
                    $set: {
                        score: graded.score,
                        totalQuestions: totalQ,
                        percentage: graded.percentage,
                        maxMarks: paperMaxMarks,
                        correctCount: graded.correctCount,
                        wrongCount: graded.wrongCount,
                        blankCount: graded.blankCount
                    }
                }
            }
        };
    });

    if (bulkOps.length > 0) {
        await Submission.bulkWrite(bulkOps);
    }

    console.log(`[Recheck] Regraded ${submissions.length} submission(s) for paper "${paperIdStr}"`);
    return submissions.length;
}

// Helper to retrieve Section / Batch / Folders (Admin creates them - no default auto-seeding)
async function getAllFolders(filterType = 'all') {
    let folders = [];
    try {
        let query = {};
        if (filterType === 'jee') {
            query = { $or: [{ examType: 'jee' }, { name: /jee/i }] };
        } else if (filterType === 'standard' || filterType === 'normal') {
            query = { examType: { $ne: 'jee' }, name: { $not: /jee/i } };
        }
        folders = await Folder.find(query).sort({ name: 1 }).lean();
    } catch (e) {
        folders = [];
    }
    return folders;
}

// Helper to delete an entire paper and all its associated submissions and Cloudinary OMR copies
async function deletePaperAndAllSubmissions(paperId) {
    const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
    if (!paper) {
        throw new Error('Paper not found');
    }
    const pIdStr = String(paper._id);

    // 1. Find all submissions for this paper
    const submissions = await Submission.find({
        $or: [
            { paper_id: pIdStr },
            { paperId: pIdStr }
        ]
    });

    let deletedFromCloudCount = 0;
    // 2. Delete all Cloudinary OMR images for these submissions
    for (const sub of submissions) {
        const pubId = sub.cloudinary_public_id || sub.cloudinaryPublicId;
        const acc = sub.cloudinary_account || sub.cloudinaryAccount;
        if (pubId) {
            try {
                await deleteOmrSheet(pubId, acc);
                deletedFromCloudCount++;
            } catch (e) {
                console.warn(`Notice: Could not delete submission ${sub._id} OMR from Cloudinary:`, e.message);
            }
        }
        if (sub.localPath) {
            try {
                if (fs.existsSync(sub.localPath)) fs.unlinkSync(sub.localPath);
            } catch (e) { }
        }
    }

    // 3. Delete all submissions from database
    const subDeleteResult = await Submission.deleteMany({
        $or: [
            { paper_id: pIdStr },
            { paperId: pIdStr }
        ]
    });

    // 4. Delete the paper document
    await Paper.findByIdAndDelete(paper._id);

    return {
        paperId: pIdStr,
        title: paper.title,
        exam_type: paper.exam_type,
        deletedSubmissionsCount: subDeleteResult.deletedCount || 0,
        deletedFromCloudCount
    };
}

// Helper to compute section-wise marks and total aggregate marks
function computeSectionWise(breakdown, totalQuestions, customSections = null) {
    let sectionDefs = [];
    if (Array.isArray(customSections) && customSections.length > 0) {
        sectionDefs = customSections.map(s => {
            const start = Number(s.from_question);
            const end = Number(s.to_question);
            const countInSec = (end >= start) ? (end - start + 1) : 1;
            const maxM = Number(s.max_marks) || (countInSec * 4);
            return {
                name: s.name,
                start: start,
                end: end,
                maxMarks: maxM
            };
        });
    } else if (totalQuestions <= 30) {
        sectionDefs = [{ name: 'Section A (General)', start: 1, end: totalQuestions }];
    } else if (totalQuestions <= 60) {
        const half = Math.ceil(totalQuestions / 2);
        sectionDefs = [
            { name: 'Section A', start: 1, end: half },
            { name: 'Section B', start: half + 1, end: totalQuestions }
        ];
    } else if (totalQuestions <= 120) {
        const qPerSec = Math.ceil(totalQuestions / 4);
        sectionDefs = [
            { name: 'Section 1 (Physics)', start: 1, end: qPerSec },
            { name: 'Section 2 (Chemistry)', start: qPerSec + 1, end: qPerSec * 2 },
            { name: 'Section 3 (Mathematics)', start: (qPerSec * 2) + 1, end: qPerSec * 3 },
            { name: 'Section 4 (General)', start: (qPerSec * 3) + 1, end: totalQuestions }
        ];
    } else {
        const qPerSec = Math.ceil(totalQuestions / 4);
        sectionDefs = [
            { name: 'Physics', start: 1, end: qPerSec },
            { name: 'Chemistry', start: qPerSec + 1, end: qPerSec * 2 },
            { name: 'Botany / Math', start: (qPerSec * 2) + 1, end: qPerSec * 3 },
            { name: 'Zoology / Aptitude', start: (qPerSec * 3) + 1, end: totalQuestions }
        ];
    }

    const breakdownMap = {};
    if (Array.isArray(breakdown)) {
        breakdown.forEach(item => {
            if (item && item.q) breakdownMap[item.q] = item.verdict;
        });
    }

    let totalAggregateMarks = 0;
    let totalMaxMarks = 0;

    const sections = sectionDefs.map(sec => {
        let correct = 0;
        let wrong = 0;
        let multiple = 0;
        let blank = 0;
        const countInSec = (sec.end - sec.start) + 1;

        for (let q = sec.start; q <= sec.end; q++) {
            const v = breakdownMap[q];
            if (v === 'correct') correct++;
            else if (v === 'wrong') wrong++;
            else if (v === 'multiple') multiple++;
            else blank++;
        }

        const marks = (correct * 4) - (wrong * 1) - (multiple * 1);
        const maxMarks = sec.maxMarks || (countInSec * 4);

        totalAggregateMarks += marks;
        totalMaxMarks += maxMarks;

        return {
            sectionName: sec.name,
            range: `Q${sec.start}-Q${sec.end}`,
            correct,
            wrong,
            multiple,
            blank,
            marks: Math.max(0, marks),
            maxMarks
        };
    });

    return {
        sectionWise: sections,
        aggregateMarks: Math.max(0, totalAggregateMarks),
        maxMarks: totalMaxMarks
    };
}

// Shared helper to resolve section definitions for a paper
function getPaperSectionsDef(paper, fallbackTotalQ = 50) {
    if (paper && Array.isArray(paper.sections) && paper.sections.length > 0) {
        return paper.sections;
    }
    const totalQ = (paper && (paper.total_questions || paper.numQuestions)) || fallbackTotalQ || 50;
    const qPerSec = Math.ceil(totalQ / 4);
    return [
        { name: 'Physics', from_question: 1, to_question: qPerSec, max_marks: qPerSec * 4 },
        { name: 'Chemistry', from_question: qPerSec + 1, to_question: qPerSec * 2, max_marks: qPerSec * 4 },
        { name: 'Botany / Math', from_question: (qPerSec * 2) + 1, to_question: qPerSec * 3, max_marks: qPerSec * 4 },
        { name: 'Zoology / Aptitude', from_question: (qPerSec * 3) + 1, to_question: totalQ, max_marks: (totalQ - (qPerSec * 3)) * 4 }
    ].filter(s => s.to_question >= s.from_question);
}

// Shared helper to dynamically evaluate a submission against its paper's current answer key & sections
function buildGradedSubmissionObj(doc, paper) {
    const defaultTotalQ = (paper && (paper.total_questions || paper.numQuestions)) || 50;
    const totalQ = doc.totalQuestions || defaultTotalQ;
    const keyLookup = paper ? buildKeyLookup(paper) : {};

    // Special handling for JEE Mains submissions
    if (doc.examType === 'jee') {
        const numScores = doc.numericalScores || {};
        const sumArr = arr => Array.isArray(arr) ? arr.reduce((a, b) => a + Number(b || 0), 0) : 0;
        const phyNvq = sumArr(numScores.phy);
        const chemNvq = sumArr(numScores.chem);
        const mathNvq = sumArr(numScores.math);
        const mcqScores = doc.mcqSubjectScores || {};

        const savedPhy = mcqScores.phy || {};
        const savedChem = mcqScores.chem || {};
        const savedMath = mcqScores.math || {};

        let phyMcq = (savedPhy.score !== undefined) ? Number(savedPhy.score) : 0;
        let chemMcq = (savedChem.score !== undefined) ? Number(savedChem.score) : 0;
        let mathMcq = (savedMath.score !== undefined) ? Number(savedMath.score) : 0;

        let phyCorr = Number(savedPhy.correct || 0);
        let phyWrng = Number(savedPhy.wrong || 0);
        let phyBlnk = Number(savedPhy.blank || 0);

        let chemCorr = Number(savedChem.correct || 0);
        let chemWrng = Number(savedChem.wrong || 0);
        let chemBlnk = Number(savedChem.blank || 0);

        let mathCorr = Number(savedMath.correct || 0);
        let mathWrng = Number(savedMath.wrong || 0);
        let mathBlnk = Number(savedMath.blank || 0);

        // Trust authentic scanned marks and breakdown.
        // ONLY recalculate if mcqSubjectScores is completely empty AND doc.score is not set.
        const hasSavedScores = (doc.mcqSubjectScores && Object.keys(doc.mcqSubjectScores).length > 0) || (doc.score !== undefined && doc.score !== null);
        if (!hasSavedScores) {
            const resps = Array.isArray(doc.responses) ? doc.responses : [];
            if (resps.length > 0 && Object.keys(keyLookup).length > 0) {
                // Physics: strictly physical OMR Q1..20
                let pS = 0, pC = 0, pW = 0, pB = 0;
                for (let q = 1; q <= 20; q++) {
                    const m = (resps[q - 1] || '').trim().toUpperCase();
                    const k = (keyLookup[q] || '').trim().toUpperCase();
                    const evalRes = evaluateQuestionVerdict(m, k, 'jee');
                    if (evalRes.isBonus || evalRes.isCorrect) { pC++; pS += 4; }
                    else if (evalRes.isBlank) { pB++; }
                    else if (evalRes.isWrong) { pW++; pS -= 1; }
                }
                phyMcq = pS; phyCorr = pC; phyWrng = pW; phyBlnk = pB;

                // Chemistry: strictly physical OMR Q41..60
                for (let omrQ = 41; omrQ <= 60; omrQ++) {
                    const m = (resps[omrQ - 1] || '').trim().toUpperCase();
                    const k = (keyLookup[omrQ] || keyLookup[26 + (omrQ - 41)] || '').trim().toUpperCase();
                    const evalRes = evaluateQuestionVerdict(m, k, 'jee');
                    if (evalRes.isBonus || evalRes.isCorrect) { cC++; cS += 4; }
                    else if (evalRes.isBlank) { cB++; }
                    else if (evalRes.isWrong) { cW++; cS -= 1; }
                }
                chemMcq = cS; chemCorr = cC; chemWrng = cW; chemBlnk = cB;

                // Mathematics: strictly physical OMR Q81..100
                for (let omrQ = 81; omrQ <= 100; omrQ++) {
                    const m = (resps[omrQ - 1] || '').trim().toUpperCase();
                    const k = (keyLookup[omrQ] || keyLookup[51 + (omrQ - 81)] || '').trim().toUpperCase();
                    const evalRes = evaluateQuestionVerdict(m, k, 'jee');
                    if (evalRes.isBonus || evalRes.isCorrect) { mC++; mS += 4; }
                    else if (evalRes.isBlank) { mB++; }
                    else if (evalRes.isWrong) { mW++; mS -= 1; }
                }
                mathMcq = mS; mathCorr = mC; mathWrng = mW; mathBlnk = mB;
            }
        }

        const phyNvqStats = countNvqForSubject(numScores.phy);
        const chemNvqStats = countNvqForSubject(numScores.chem);
        const mathNvqStats = countNvqForSubject(numScores.math);

        const phyTotalCorr = phyCorr + phyNvqStats.corr;
        const phyTotalWrng = phyWrng + phyNvqStats.wrng;
        const phyTotalBlnk = phyBlnk + phyNvqStats.blnk;
        const phyTotalAtt = phyTotalCorr + phyTotalWrng;

        const chemTotalCorr = chemCorr + chemNvqStats.corr;
        const chemTotalWrng = chemWrng + chemNvqStats.wrng;
        const chemTotalBlnk = chemBlnk + chemNvqStats.blnk;
        const chemTotalAtt = chemTotalCorr + chemTotalWrng;

        const mathTotalCorr = mathCorr + mathNvqStats.corr;
        const mathTotalWrng = mathWrng + mathNvqStats.wrng;
        const mathTotalBlnk = mathBlnk + mathNvqStats.blnk;
        const mathTotalAtt = mathTotalCorr + mathTotalWrng;

        const sectionWise = [
            {
                sectionName: 'Physics',
                range: '',
                correct: phyTotalCorr,
                wrong: phyTotalWrng,
                blank: phyTotalBlnk,
                totalQuestions: 25,
                attempted: phyTotalAtt,
                unattempted: phyTotalBlnk,
                marks: phyMcq + phyNvq,
                maxMarks: 100
            },
            {
                sectionName: 'Chemistry',
                range: '',
                correct: chemTotalCorr,
                wrong: chemTotalWrng,
                blank: chemTotalBlnk,
                totalQuestions: 25,
                attempted: chemTotalAtt,
                unattempted: chemTotalBlnk,
                marks: chemMcq + chemNvq,
                maxMarks: 100
            },
            {
                sectionName: 'Mathematics',
                range: '',
                correct: mathTotalCorr,
                wrong: mathTotalWrng,
                blank: mathTotalBlnk,
                totalQuestions: 25,
                attempted: mathTotalAtt,
                unattempted: mathTotalBlnk,
                marks: mathMcq + mathNvq,
                maxMarks: 100
            }
        ];

        const obj = (typeof doc.toObject === 'function') ? doc.toObject({ virtuals: true }) : { ...doc };
        obj.sectionWise = sectionWise;
        obj.answerKeyLookup = keyLookup;
        obj.paperTitle = paper ? paper.title : (doc.paper_id || 'JEE Exam Paper');
        obj.paperSubject = 'JEE Mains';
        obj.paperCategory = (paper && (paper.category || paper.batch)) ? (paper.category || paper.batch).trim() : 'JEE Mains';
        obj.paperExamType = 'jee';
        obj.maxMarks = 300;
        obj.score = (doc.score !== undefined && doc.score !== null) ? Number(doc.score) : ((phyMcq + phyNvq) + (chemMcq + chemNvq) + (mathMcq + mathNvq));
        obj.aggregateMarks = obj.score;
        obj.breakdown = doc.breakdown || [];
        obj.allSectionsSummary = summarizeSections(sectionWise, obj).totals;
        return obj;
    }

    const sectionsDef = getPaperSectionsDef(paper, totalQ);

    if (Array.isArray(doc.responses) && doc.responses.length > 0 && paper) {
        const graded = evaluateResponsesAgainstKey(doc.responses, keyLookup, totalQ);
        doc.score = graded.score;
        doc.correctCount = graded.correctCount;
        doc.wrongCount = graded.wrongCount;
        doc.blankCount = graded.blankCount;
        doc.percentage = graded.percentage;
    }

    const resps = Array.isArray(doc.responses) ? doc.responses : [];
    const sectionWise = sectionsDef.map(s => {
        let secCorrect = 0;
        let secWrong = 0;
        let secBlank = 0;
        const fromQ = Number(s.from_question);
        const toQ = Number(s.to_question);
        const countInSec = (toQ >= fromQ) ? (toQ - fromQ + 1) : 0;

        for (let q = fromQ; q <= toQ; q++) {
            const marked = resps[q - 1] ? String(resps[q - 1]).trim().toUpperCase() : '';
            const key = keyLookup[q] ? String(keyLookup[q]).trim().toUpperCase() : '';
            const evalRes = evaluateQuestionVerdict(marked, key, 'jee');
            if (evalRes.isBonus || evalRes.isCorrect) {
                secCorrect++;
            } else if (evalRes.isBlank) {
                secBlank++;
            } else if (evalRes.isWrong) {
                secWrong++;
            }
        }

        const secMarks = (secCorrect * 4) - secWrong;
        const secAttempted = Math.max(0, countInSec - secBlank);
        return {
            sectionName: s.name,
            range: `Q${fromQ}-Q${toQ}`,
            correct: secCorrect,
            wrong: secWrong,
            blank: secBlank,
            totalQuestions: countInSec,
            attempted: secAttempted,
            unattempted: secBlank,
            marks: Math.max(0, secMarks),
            maxMarks: s.max_marks || (countInSec * 4)
        };
    });

    const obj = (typeof doc.toObject === 'function') ? doc.toObject({ virtuals: true }) : { ...doc };
    obj.sectionWise = sectionWise;
    obj.answerKeyLookup = keyLookup;
    obj.paperTitle = paper ? paper.title : (doc.paper_id || 'Exam Paper');
    obj.paperSubject = paper ? (paper.subject || 'General') : 'General';
    obj.paperCategory = (paper && (paper.category || paper.batch)) ? (paper.category || paper.batch).trim() : 'General';
    obj.paperExamType = paper ? (paper.exam_type || paper.examType || 'standard') : (doc.examType || 'standard');
    obj.maxMarks = paper ? (paper.max_marks || (totalQ * 4)) : (doc.maxMarks || (totalQ * 4));
    obj.breakdown = doc.breakdown || [];
    obj.allSectionsSummary = summarizeSections(sectionWise, obj).totals;
    return obj;
}

// Alias for backwards compatibility
const augmentSubmissionDoc = buildGradedSubmissionObj;

async function buildStudentNameMap(results) {
    const rollVariants = [];
    const lowerRolls = new Set();
    const studentNameByRoll = {};

    (results || []).forEach(r => {
        const roll = String((r && (r.rollnumber || r.rollNumber)) || '').trim();
        if (!roll) return;
        const lowRoll = roll.toLowerCase();
        rollVariants.push(roll, roll.toUpperCase(), lowRoll);
        lowerRolls.add(lowRoll);
        if (r.studentName && typeof r.studentName === 'string' && r.studentName.trim()) {
            studentNameByRoll[lowRoll] = r.studentName.trim();
        }
    });

    const uniqueRolls = [...new Set(rollVariants.filter(Boolean))];
    if (uniqueRolls.length > 0) {
        const users = await User.find({
            $or: [
                { rollnumber: { $in: uniqueRolls } },
                { username: { $in: [...lowerRolls] } }
            ]
        }, 'username rollnumber fullName').lean();

        users.forEach(u => {
            const name = u.fullName ? String(u.fullName).trim() : '';
            if (!name) return;
            if (u.rollnumber) studentNameByRoll[String(u.rollnumber).trim().toLowerCase()] = name;
            if (u.username) studentNameByRoll[String(u.username).trim().toLowerCase()] = name;
        });
    }
    return studentNameByRoll;
}

function getGradedSubmissionScore(graded) {
    if (!graded) return 0;
    if (graded.allSectionsSummary && graded.allSectionsSummary.obtainedMarks !== undefined) {
        return Number(graded.allSectionsSummary.obtainedMarks) || 0;
    }
    if (graded.aggregateMarks !== undefined) {
        return Number(graded.aggregateMarks) || 0;
    }
    return Number(graded.score || 0);
}

async function getSortedGradedPaperResults(paper, fallbackPaperId = null) {
    const paperId = paper ? (paper._id || paper.id) : fallbackPaperId;
    if (!paperId) return [];

    const orConditions = [
        { paper_id: String(paperId) },
        { paper_id: paperId },
        { paperId: paperId }
    ];
    if (mongoose.Types.ObjectId.isValid(paperId) && String(new mongoose.Types.ObjectId(paperId)) === String(paperId)) {
        orConditions.push({ paper_id: new mongoose.Types.ObjectId(paperId) });
        orConditions.push({ paperId: new mongoose.Types.ObjectId(paperId) });
    }

    const docs = await Submission.find({
        $or: orConditions
    }).sort({ score: -1, submitted_at: -1, scannedAt: -1 });

    const results = docs.map(doc => buildGradedSubmissionObj(doc, paper));
    results.sort((a, b) => {
        const scoreA = getGradedSubmissionScore(a);
        const scoreB = getGradedSubmissionScore(b);
        if (scoreB !== scoreA) return scoreB - scoreA;
        const timeA = new Date(a.submitted_at || a.scannedAt || 0).getTime();
        const timeB = new Date(b.submitted_at || b.scannedAt || 0).getTime();
        return timeB - timeA;
    });

    let currentRank = 1;
    for (let i = 0; i < results.length; i++) {
        if (i > 0) {
            const prevScore = getGradedSubmissionScore(results[i - 1]);
            const currScore = getGradedSubmissionScore(results[i]);
            if (currScore < prevScore) {
                currentRank = i + 1;
            }
        }
        results[i].rank = currentRank;
        results[i].position = i + 1;
        results[i].totalCandidates = results.length;
    }

    return results;
}

module.exports = {
    getAnswerKeyJson,
    buildKeyLookup,
    getAnswerKeyLookup,
    evaluateResponsesAgainstKey,
    countNvqForSubject,
    regradePaperSubmissions,
    getAllFolders,
    deletePaperAndAllSubmissions,
    computeSectionWise,
    getPaperSectionsDef,
    buildGradedSubmissionObj,
    augmentSubmissionDoc,
    buildStudentNameMap,
    getGradedSubmissionScore,
    getSortedGradedPaperResults
};
