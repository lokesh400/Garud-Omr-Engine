const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const Paper = require('../models/Paper');
const Submission = require('../models/Submission');
const User = require('../models/User');
const {
    requireAdmin,
    validateIdParam
} = require('../middleware/auth');
const {
    scanLimiter,
    secureImageUpload,
    uploadDir
} = require('../utils/security');
const { uploadOmrSheet, deleteOmrSheet } = require('../utils/cloudinaryPool');
const { evaluateQuestionVerdict } = require('../utils/omrEvaluator');
const {
    getAnswerKeyJson,
    buildKeyLookup,
    evaluateResponsesAgainstKey,
    buildGradedSubmissionObj
} = require('../services/paperService');

const upload = secureImageUpload;

router.param('id', validateIdParam);

router.get('/paper/:id/scan', requireAdmin, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id);
        if (!paper) return res.status(404).send('Paper not found');
        res.render('scanner', { paper, answerKey: getAnswerKeyJson(paper) });
    } catch (error) {
        res.status(500).send('Error loading scanner: ' + error.message);
    }
});

router.post('/paper/:id/check', requireAdmin, scanLimiter.middleware(), upload.single('omrSheet'), async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id);
        if (!paper) return res.status(404).send('Paper not found');

        if (!req.file) {
            return res.status(400).send('No file selected. Please go back and upload an image file.');
        }

        res.render('evaluator', {
            paper,
            imagePath: '/uploads/' + req.file.filename,
            answerKey: getAnswerKeyJson(paper)
        });
    } catch (error) {
        console.error('Evaluation upload error:', error);
        res.status(500).send('Error processing upload: ' + error.message);
    }
});

// JEE Mains Live Camera Scanner (Q1-20, Q41-60, Q81-100 + Section B Numerical)
router.get('/paper/:id/jee-scan', requireAdmin, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id) || await Paper.findOne({ _id: decodeURIComponent(req.params.id) });
        if (!paper) return res.status(404).send('Paper not found');
        res.render('jee_scanner', { paper, answerKey: getAnswerKeyJson(paper) });
    } catch (error) {
        res.status(500).send('Error loading JEE scanner: ' + error.message);
    }
});

// JEE Mains Manual/File Sheet Evaluator
router.get('/paper/:id/jee-evaluator', requireAdmin, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id) || await Paper.findOne({ _id: decodeURIComponent(req.params.id) });
        if (!paper) return res.status(404).send('Paper not found');
        res.render('jee_evaluator', {
            paper,
            imagePath: '',
            answerKey: getAnswerKeyJson(paper)
        });
    } catch (error) {
        res.status(500).send('Error loading JEE evaluator: ' + error.message);
    }
});

// JEE Mains Image Upload Evaluator
router.post('/paper/:id/jee-check', requireAdmin, scanLimiter.middleware(), secureImageUpload.single('omrSheet'), async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id) || await Paper.findOne({ _id: decodeURIComponent(req.params.id) });
        if (!paper) return res.status(404).send('Paper not found');

        if (!req.file) {
            return res.status(400).send('No file selected. Please go back and upload an image file.');
        }

        res.render('jee_evaluator', {
            paper,
            imagePath: '/uploads/' + req.file.filename,
            answerKey: getAnswerKeyJson(paper)
        });
    } catch (error) {
        console.error('JEE Evaluation upload error:', error);
        res.status(500).send('Error processing JEE upload: ' + error.message);
    }
});

// Save Evaluated Result to Cloudinary & MongoDB (submissions collection)
router.post('/api/paper/:id/save-result', requireAdmin, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) return res.status(404).json({ error: 'Paper not found' });

        if (!req.body) {
            return res.status(400).json({ error: 'Missing request body' });
        }

        const {
            rollnumber,
            rollNumber,
            score,
            totalQuestions,
            correctCount,
            wrongCount,
            multipleCount,
            blankCount,
            breakdown,
            responses,
            imageData
        } = req.body;

        if (!imageData) {
            return res.status(400).json({ error: 'Image data is required' });
        }

        const studentRoll = (rollnumber || rollNumber || 'STUDENT-' + Date.now().toString().slice(-4)).toString().trim();
        const totalQ = Number(totalQuestions) || paper.numQuestions || 50;

        console.log(`[Save Result] Processing OMR submission for roll: "${studentRoll}" on paper: "${paper._id}"`);

        // Upload clean leveled OMR image to Cloudinary (using 5-account rotation)
        let uploadResult = null;
        try {
            uploadResult = await uploadOmrSheet(imageData, {
                rollNumber: studentRoll,
                paperId: String(paper._id)
            });
            console.log(`[Cloudinary] Successfully uploaded OMR copy for ${studentRoll} to account: ${uploadResult.account}`);
        } catch (cloudErr) {
            console.warn(`[Cloudinary Warning] Upload to Cloudinary pool failed (${cloudErr.message}). Saving copy locally as fallback.`);
            const filename = `omr_${Date.now()}_${studentRoll.replace(/[^\w-]/g, '_')}.jpg`;
            const localFilePath = path.join(uploadDir, filename);
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
            fs.writeFileSync(localFilePath, Buffer.from(base64Data, 'base64'));
            uploadResult = {
                url: '/uploads/' + filename,
                publicId: 'local_' + filename,
                account: 'local_storage'
            };
        }

        // Build 180 (or totalQ) responses array: ["A", "B", null, "C", ...]
        let responsesArray = [];
        if (Array.isArray(responses) && responses.length > 0) {
            responsesArray = responses;
        } else if (Array.isArray(breakdown)) {
            responsesArray = new Array(totalQ).fill(null);
            breakdown.forEach(item => {
                if (item && item.q) {
                    const idx = Number(item.q) - 1;
                    if (idx >= 0 && idx < totalQ) {
                        if (item.marked && typeof item.marked === 'string' && item.marked.trim() !== '' && item.verdict !== 'blank') {
                            responsesArray[idx] = item.marked.trim().toUpperCase();
                        } else {
                            responsesArray[idx] = null;
                        }
                    }
                }
            });
        }

        const graded = responsesArray.length > 0
            ? evaluateResponsesAgainstKey(responsesArray, buildKeyLookup(paper), totalQ)
            : {
                score: Number(score || 0),
                correctCount: Number(correctCount || 0),
                wrongCount: Number(wrongCount || 0),
                blankCount: Number(blankCount || 0),
                percentage: totalQ > 0 ? Math.round((Number(score || 0) / totalQ) * 100) : 0
            };

        const newSubmission = new Submission({
            rollnumber: studentRoll,
            paper_id: String(paper._id),
            submitted_at: new Date(),
            responses: responsesArray,
            cloudinary_image_url: uploadResult.url,
            cloudinary_public_id: uploadResult.publicId,
            cloudinary_account: uploadResult.account,
            score: graded.score,
            totalQuestions: totalQ,
            percentage: graded.percentage,
            maxMarks: paper.max_marks || (totalQ * 4),
            correctCount: graded.correctCount,
            wrongCount: graded.wrongCount,
            blankCount: graded.blankCount,
            breakdown: Array.isArray(breakdown) ? breakdown : []
        });

        await newSubmission.save();

        res.json({
            success: true,
            submissionId: newSubmission._id,
            resultId: newSubmission._id,
            rollnumber: newSubmission.rollnumber,
            paper_id: newSubmission.paper_id,
            cloudinary_image_url: newSubmission.cloudinary_image_url,
            cloudinary_public_id: newSubmission.cloudinary_public_id,
            omrImageUrl: newSubmission.cloudinary_image_url,
            aggregateMarks: newSubmission.aggregateMarks,
            responses: newSubmission.responses,
            cloudinaryAccount: uploadResult.account
        });
    } catch (error) {
        console.error('Error saving evaluation result:', error);
        res.status(500).json({ error: error.message });
    }
});

// Save JEE Mains Evaluated Result (Q1-20, Q41-60, Q81-100 + Section B Numerical)
router.post('/api/paper/:id/jee-save-result', requireAdmin, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) return res.status(404).json({ error: 'Paper not found' });

        if (!req.body) {
            return res.status(400).json({ error: 'Missing request body' });
        }

        const {
            rollnumber,
            rollNumber,
            score,
            totalQuestions,
            maxMarks,
            numericalScores,
            mcqSubjectScores,
            breakdown,
            imageData
        } = req.body;

        if (!imageData) {
            return res.status(400).json({ error: 'Image data is required' });
        }

        const studentRoll = (rollnumber || rollNumber || 'STUDENT-' + Date.now().toString().slice(-4)).toString().trim();
        const totalQ = Number(totalQuestions) || 75;
        const maxM = Number(maxMarks) || 300;
        const totalScore = Number(score !== undefined ? score : 0);

        console.log(`[JEE Save Result] Processing JEE OMR submission for roll: "${studentRoll}" on paper: "${paper._id}" (Score: ${totalScore}/${maxM})`);

        // Upload clean leveled OMR image to Cloudinary (using 5-account rotation)
        let uploadResult = null;
        try {
            uploadResult = await uploadOmrSheet(imageData, {
                rollNumber: studentRoll,
                paperId: String(paper._id)
            });
            console.log(`[Cloudinary] Successfully uploaded JEE OMR copy for ${studentRoll} to account: ${uploadResult.account}`);
        } catch (cloudErr) {
            console.warn(`[Cloudinary Warning] Upload to Cloudinary pool failed (${cloudErr.message}). Saving copy locally as fallback.`);
            const filename = `jee_omr_${Date.now()}_${studentRoll.replace(/[^\w-]/g, '_')}.jpg`;
            const localFilePath = path.join(uploadDir, filename);
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
            fs.writeFileSync(localFilePath, Buffer.from(base64Data, 'base64'));
            uploadResult = {
                url: '/uploads/' + filename,
                publicId: 'local_' + filename,
                account: 'local_storage'
            };
        }

        // Build 100-length responses array strictly at physical OMR positions for JEE
        const responsesArray = new Array(100).fill(null);
        let correctCount = 0;
        let wrongCount = 0;
        let blankCount = 0;

        if (Array.isArray(breakdown)) {
            breakdown.forEach(item => {
                if (item) {
                    const omrQ = Number(item.omrQ);
                    const isNum = Boolean(item.isNumerical);
                    const markedVal = (!isNum && item.marked && typeof item.marked === 'string' && item.marked.trim() !== '' && item.verdict !== 'blank')
                        ? item.marked.trim().toUpperCase()
                        : null;

                    // Strictly save at actual physical OMR question index (1..100 -> 0..99)
                    // NEVER write to dispQ to avoid collision between chemistry/math and unused bubble rows
                    if (omrQ >= 1 && omrQ <= 100 && markedVal) {
                        responsesArray[omrQ - 1] = markedVal;
                    }

                    if (item.verdict === 'correct' || item.verdict === 'bonus') correctCount++;
                    else if (item.verdict === 'wrong' || item.verdict === 'multiple') wrongCount++;
                    else blankCount++;
                }
            });
        }

        // Numerical Questions grading tally
        const numScores = numericalScores || {};
        ['phy', 'chem', 'math'].forEach(sub => {
            const arr = numScores[sub] || [];
            arr.forEach(val => {
                const n = Number(val);
                if (n === 4) correctCount++;
                else if (n === -1) wrongCount++;
                else blankCount++;
            });
        });

        const percentage = maxM > 0 ? Math.round((totalScore / maxM) * 100) : 0;

        const newSubmission = new Submission({
            rollnumber: studentRoll,
            paper_id: String(paper._id),
            submitted_at: new Date(),
            responses: responsesArray,
            cloudinary_image_url: uploadResult.url,
            cloudinary_public_id: uploadResult.publicId,
            cloudinary_account: uploadResult.account,
            score: totalScore,
            totalQuestions: totalQ,
            percentage: percentage,
            maxMarks: maxM,
            correctCount: correctCount,
            wrongCount: wrongCount,
            blankCount: blankCount,
            examType: 'jee',
            numericalScores: numericalScores || {},
            mcqSubjectScores: mcqSubjectScores || {},
            breakdown: Array.isArray(breakdown) ? breakdown : []
        });

        await newSubmission.save();

        res.json({
            success: true,
            submissionId: newSubmission._id,
            resultId: newSubmission._id,
            rollnumber: newSubmission.rollnumber,
            paper_id: newSubmission.paper_id,
            score: newSubmission.score,
            maxMarks: newSubmission.maxMarks,
            cloudinary_image_url: newSubmission.cloudinary_image_url,
            cloudinary_public_id: newSubmission.cloudinary_public_id,
            omrImageUrl: newSubmission.cloudinary_image_url,
            aggregateMarks: newSubmission.score,
            responses: newSubmission.responses,
            cloudinaryAccount: uploadResult.account
        });
    } catch (error) {
        console.error('Error saving JEE evaluation result:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update Student Name for a submission and roll number
router.post('/api/submission/:id/student-name', requireAdmin, async (req, res) => {
    try {
        const subId = req.params.id;
        const newName = String(req.body.studentName || '').trim();
        const sub = await Submission.findById(subId);
        if (!sub) return res.status(404).json({ error: 'Submission not found' });

        const roll = String(sub.rollnumber || '').trim();
        sub.studentName = newName;
        await sub.save();

        if (roll && roll !== 'UNKNOWN') {
            await Submission.updateMany({ rollnumber: roll }, { $set: { studentName: newName } });
            await User.updateMany(
                { $or: [{ rollnumber: roll }, { username: roll.toLowerCase() }] },
                { $set: { fullName: newName } }
            );
        }

        res.json({ success: true, studentName: newName, rollnumber: roll });
    } catch (err) {
        console.error('Error updating student name:', err);
        res.status(500).json({ error: err.message });
    }
});

// Edit Numerical Answers for a student's submission (Admin only)
router.post('/api/submission/:id/numerical', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { numericalScores } = req.body;
        if (!numericalScores || typeof numericalScores !== 'object') {
            return res.status(400).json({ error: 'numericalScores object is required' });
        }

        const sub = await Submission.findById(id);
        if (!sub) {
            return res.status(404).json({ error: 'Submission not found' });
        }

        // Clean & sanitize input { phy: [5], chem: [5], math: [5] }
        const cleanScores = {
            phy: Array.isArray(numericalScores.phy) ? numericalScores.phy.slice(0, 5).map(v => Number(v) || 0) : [0, 0, 0, 0, 0],
            chem: Array.isArray(numericalScores.chem) ? numericalScores.chem.slice(0, 5).map(v => Number(v) || 0) : [0, 0, 0, 0, 0],
            math: Array.isArray(numericalScores.math) ? numericalScores.math.slice(0, 5).map(v => Number(v) || 0) : [0, 0, 0, 0, 0]
        };

        sub.numericalScores = cleanScores;

        const paper = await Paper.findById(sub.paper_id);
        const keyLookup = buildKeyLookup(paper);
        const resps = Array.isArray(sub.responses) ? sub.responses : [];

        // 1. Calculate MCQ counts & marks
        let phyMcq = 0, chemMcq = 0, mathMcq = 0;
        let phyCorr = 0, phyWrng = 0, phyBlnk = 0;
        let chemCorr = 0, chemWrng = 0, chemBlnk = 0;
        let mathCorr = 0, mathWrng = 0, mathBlnk = 0;

        const savedMcq = sub.mcqSubjectScores || {};
        if (savedMcq.phy && savedMcq.phy.score !== undefined) {
            phyMcq = Number(savedMcq.phy.score || 0);
            phyCorr = Number(savedMcq.phy.correct || 0);
            phyWrng = Number(savedMcq.phy.wrong || 0) + Number(savedMcq.phy.multiple || 0);
            phyBlnk = Number(savedMcq.phy.blank || 0);
        } else {
            for (let q = 1; q <= 20; q++) {
                const m = (resps[q - 1] || '').trim().toUpperCase();
                const k = (keyLookup[q] || '').trim().toUpperCase();
                const evalRes = evaluateQuestionVerdict(m, k, 'jee');
                if (evalRes.isBonus || evalRes.isCorrect) { phyCorr++; phyMcq += 4; }
                else if (evalRes.isBlank) { phyBlnk++; }
                else if (evalRes.isWrong) { phyWrng++; phyMcq -= 1; }
            }
        }

        if (savedMcq.chem && savedMcq.chem.score !== undefined) {
            chemMcq = Number(savedMcq.chem.score || 0);
            chemCorr = Number(savedMcq.chem.correct || 0);
            chemWrng = Number(savedMcq.chem.wrong || 0) + Number(savedMcq.chem.multiple || 0);
            chemBlnk = Number(savedMcq.chem.blank || 0);
        } else {
            for (let omrQ = 41; omrQ <= 60; omrQ++) {
                const m = (resps[omrQ - 1] || '').trim().toUpperCase();
                const k = (keyLookup[omrQ] || keyLookup[26 + (omrQ - 41)] || '').trim().toUpperCase();
                const evalRes = evaluateQuestionVerdict(m, k, 'jee');
                if (evalRes.isBonus || evalRes.isCorrect) { chemCorr++; chemMcq += 4; }
                else if (evalRes.isBlank) { chemBlnk++; }
                else if (evalRes.isWrong) { chemWrng++; chemMcq -= 1; }
            }
        }

        if (savedMcq.math && savedMcq.math.score !== undefined) {
            mathMcq = Number(savedMcq.math.score || 0);
            mathCorr = Number(savedMcq.math.correct || 0);
            mathWrng = Number(savedMcq.math.wrong || 0) + Number(savedMcq.math.multiple || 0);
            mathBlnk = Number(savedMcq.math.blank || 0);
        } else {
            for (let omrQ = 81; omrQ <= 100; omrQ++) {
                const m = (resps[omrQ - 1] || '').trim().toUpperCase();
                const k = (keyLookup[omrQ] || keyLookup[51 + (omrQ - 81)] || '').trim().toUpperCase();
                const evalRes = evaluateQuestionVerdict(m, k, 'jee');
                if (evalRes.isBonus || evalRes.isCorrect) { mathCorr++; mathMcq += 4; }
                else if (evalRes.isBlank) { mathBlnk++; }
                else if (evalRes.isWrong) { mathWrng++; mathMcq -= 1; }
            }
        }

        // 2. NVQ totals
        const sumArr = arr => (Array.isArray(arr) ? arr.reduce((a, b) => a + (Number(b) || 0), 0) : 0);
        const phyNvq = sumArr(cleanScores.phy);
        const chemNvq = sumArr(cleanScores.chem);
        const mathNvq = sumArr(cleanScores.math);

        let nvqCorr = 0, nvqWrng = 0, nvqBlnk = 0;
        ['phy', 'chem', 'math'].forEach(subKey => {
            (cleanScores[subKey] || []).forEach(v => {
                const n = Number(v);
                if (n === 4) nvqCorr++;
                else if (n === -1) nvqWrng++;
                else nvqBlnk++;
            });
        });

        const totalScore = phyMcq + phyNvq + chemMcq + chemNvq + mathMcq + mathNvq;
        const totalCorr = phyCorr + chemCorr + mathCorr + nvqCorr;
        const totalWrng = phyWrng + chemWrng + mathWrng + nvqWrng;
        const totalBlnk = phyBlnk + chemBlnk + mathBlnk + nvqBlnk;
        const maxM = sub.maxMarks || 300;
        const percentage = maxM > 0 ? Math.round((totalScore / maxM) * 100) : 0;

        sub.score = totalScore;
        sub.correctCount = totalCorr;
        sub.wrongCount = totalWrng;
        sub.blankCount = totalBlnk;
        sub.percentage = percentage;

        // 3. Update breakdown array in place
        if (Array.isArray(sub.breakdown) && sub.breakdown.length > 0) {
            sub.breakdown.forEach(item => {
                if (item.isNumerical) {
                    let subKey = item.subKey;
                    if (!subKey) {
                        subKey = item.q > 70 ? 'math' : (item.q > 45 ? 'chem' : 'phy');
                    }
                    const idx = item.nvqIndex !== undefined ? item.nvqIndex : (item.q > 70 ? item.q - 71 : (item.q > 45 ? item.q - 46 : item.q - 21));
                    if (cleanScores[subKey] && cleanScores[subKey][idx] !== undefined) {
                        const val = cleanScores[subKey][idx];
                        if (val === 4) {
                            item.verdict = 'correct';
                            item.marks = '+4';
                            item.marked = '+4 (Correct)';
                        } else if (val === -1) {
                            item.verdict = 'wrong';
                            item.marks = '-1';
                            item.marked = '-1 (Wrong)';
                        } else {
                            item.verdict = 'blank';
                            item.marks = '0';
                            item.marked = 'Blank';
                        }
                    }
                }
            });
        }

        sub.markModified('numericalScores');
        sub.markModified('breakdown');
        await sub.save();

        const augmented = buildGradedSubmissionObj(sub, paper);
        res.json({
            success: true,
            submission: augmented,
            message: 'Numerical scores updated successfully'
        });
    } catch (error) {
        console.error('Error updating numerical scores:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete Submission and its associated Cloudinary image
router.delete('/api/submission/:id', requireAdmin, async (req, res) => {
    try {
        const submission = await Submission.findById(req.params.id);
        if (!submission) {
            return res.status(404).json({ error: 'Submission not found' });
        }

        const publicId = submission.cloudinary_public_id || submission.cloudinaryPublicId;
        const accountName = submission.cloudinary_account || submission.cloudinaryAccount;

        let cloudDeleted = false;
        if (publicId) {
            try {
                const delRes = await deleteOmrSheet(publicId, accountName);
                cloudDeleted = (delRes && delRes.result === 'ok');
            } catch (cloudErr) {
                console.warn('Notice: Could not delete from Cloudinary:', cloudErr.message);
            }
        }

        await Submission.findByIdAndDelete(req.params.id);

        res.json({
            success: true,
            message: 'Submission and Cloudinary OMR copy deleted successfully',
            deletedId: req.params.id,
            cloudinaryDeleted: cloudDeleted
        });
    } catch (error) {
        console.error('Error deleting submission:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
