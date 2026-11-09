const dns = require('dns');
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Paper = require('./models/Paper');
const Submission = require('./models/Submission');
const Result = Submission;
const { uploadOmrSheet, deleteOmrSheet } = require('./utils/cloudinaryPool');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT

// Ensure upload directory exists
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Setup mongoose connection
mongoose.connect(process.env.MONGO_URL)
    .then(() => {
        console.log('Connected to MongoDB');
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    })
    .catch(err => console.error('MongoDB connection error:', err));

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer setup for uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Helper to convert answer key to object
function getAnswerKeyJson(paper) {
    if (!paper) return '{}';
    const obj = {};
    if (Array.isArray(paper.answer_key) && paper.answer_key.length > 0) {
        paper.answer_key.forEach((val, idx) => {
            if (val) obj[String(idx + 1)] = val;
        });
        return JSON.stringify(obj);
    }
    if (paper.answerKey instanceof Map) {
        return JSON.stringify(Object.fromEntries(paper.answerKey));
    }
    if (typeof paper.answerKey === 'object' && paper.answerKey !== null) {
        if (typeof paper.answerKey.toObject === 'function') {
            return JSON.stringify(paper.answerKey.toObject());
        }
        return JSON.stringify(paper.answerKey);
    }
    return '{}';
}

// Routes
app.get('/', async (req, res) => {
    try {
        const papers = await Paper.find().sort({ createdAt: -1 });
        res.render('index', { papers });
    } catch (e) {
        res.status(500).send('Error loading papers: ' + e.message);
    }
});

app.get('/paper/new', (req, res) => {
    res.render('create_paper');
});

app.post('/paper/new', async (req, res) => {
    try {
        const {
            paper_id,
            id,
            title,
            subject,
            total_questions,
            numQuestions,
            max_marks,
            sections,
            answer_key
        } = req.body;

        const totalQ = Number(total_questions || numQuestions) || 50;
        const maxM = Number(max_marks) || (totalQ * 4);

        let parsedSections = [];
        if (typeof sections === 'string' && sections.trim() !== '') {
            try {
                parsedSections = JSON.parse(sections);
            } catch (e) {
                console.warn('Invalid sections JSON:', e.message);
            }
        } else if (Array.isArray(sections)) {
            parsedSections = sections;
        }

        let parsedAnswerKey = [];
        if (typeof answer_key === 'string' && answer_key.trim() !== '') {
            try {
                parsedAnswerKey = JSON.parse(answer_key);
            } catch (e) {
                console.warn('Invalid answer_key JSON:', e.message);
            }
        } else if (Array.isArray(answer_key)) {
            parsedAnswerKey = answer_key;
        }

        const paperData = {
            title: title ? title.trim() : 'Untitled Paper',
            subject: subject ? subject.trim() : 'General',
            total_questions: totalQ,
            max_marks: maxM,
            sections: parsedSections,
            answer_key: parsedAnswerKey
        };

        const customId = (paper_id || id || '').trim();
        if (customId) {
            paperData._id = customId;
        }

        const newPaper = new Paper(paperData);
        await newPaper.save();
        res.redirect(`/paper/${newPaper._id}`);
    } catch (error) {
        console.error('Error creating paper:', error);
        res.status(500).send('Error creating paper: ' + error.message);
    }
});

app.get('/paper/:id', async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id);
        if (!paper) return res.status(404).send('Paper not found');
        res.render('paper_detail', { paper });
    } catch (error) {
        res.status(500).send('Error loading paper: ' + error.message);
    }
});

app.get('/paper/:id/omr', async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id);
        if (!paper) return res.status(404).send('Paper not found');
        res.render('omr_sheet', { paper });
    } catch (error) {
        res.status(500).send('Error loading OMR sheet: ' + error.message);
    }
});

app.post('/paper/:id/answerkey', async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id);
        if (!paper) return res.status(404).send('Paper not found');

        const totalQ = paper.total_questions || paper.numQuestions || 50;
        const answerKeyArr = new Array(totalQ).fill(null);

        for (let i = 1; i <= totalQ; i++) {
            const val = req.body[`q${i}`];
            if (val && typeof val === 'string' && val.trim() !== '') {
                answerKeyArr[i - 1] = val.trim().toUpperCase();
            } else {
                answerKeyArr[i - 1] = null;
            }
        }

        paper.answer_key = answerKeyArr;
        await paper.save();
        res.redirect(`/paper/${paper._id}`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error saving answer key: ' + error.message);
    }
});

// Update or configure sections for a paper
app.post('/paper/:id/sections', async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id);
        if (!paper) return res.status(404).json({ error: 'Paper not found' });

        let parsedSections = [];
        const raw = req.body.sections;
        if (typeof raw === 'string') {
            parsedSections = JSON.parse(raw);
        } else if (Array.isArray(raw)) {
            parsedSections = raw;
        }

        paper.sections = parsedSections;
        await paper.save();

        res.json({ success: true, sections: paper.sections });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/paper/:id/scan', async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id);
        if (!paper) return res.status(404).send('Paper not found');
        res.render('scanner', { paper, answerKey: getAnswerKeyJson(paper) });
    } catch (error) {
        res.status(500).send('Error loading scanner: ' + error.message);
    }
});

app.post('/paper/:id/check', upload.single('omrSheet'), async (req, res) => {
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

// Save Evaluated Result to Cloudinary & MongoDB (submissions collection)
app.post('/api/paper/:id/save-result', async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id);
        if (!paper) return res.status(404).json({ error: 'Paper not found' });

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

        // Upload checked OMR image with green/red marks to Cloudinary (using 5-account rotation)
        const uploadResult = await uploadOmrSheet(imageData, {
            rollNumber: studentRoll,
            paperId: req.params.id
        });

        // Compute section wise marks & aggregate using custom paper sections if defined
        const secCalc = computeSectionWise(breakdown, totalQ, paper.sections);
        const percentage = totalQ > 0 ? Math.round((Number(score || 0) / totalQ) * 100) : 0;

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

        const newSubmission = new Submission({
            rollnumber: studentRoll,
            paper_id: String(paper._id),
            submitted_at: new Date(),
            responses: responsesArray,
            cloudinary_image_url: uploadResult.url,
            cloudinary_public_id: uploadResult.publicId,
            cloudinary_account: uploadResult.account,
            score: Number(score || 0),
            totalQuestions: totalQ,
            percentage,
            maxMarks: paper.max_marks || (totalQ * 4),
            correctCount: Number(correctCount || 0),
            wrongCount: Number(wrongCount || 0),
            blankCount: Number(blankCount || 0)
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

// Delete Submission and its associated Cloudinary image
app.delete('/api/submission/:id', async (req, res) => {
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

// View All Results & Evaluated OMR Copies for Paper
app.get('/paper/:id/results', async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id);
        if (!paper) return res.status(404).send('Paper not found');

        const results = await Submission.find({
            $or: [
                { paper_id: String(paper._id) },
                { paper_id: paper._id },
                { paperId: paper._id }
            ]
        }).sort({ score: -1, submitted_at: -1, scannedAt: -1 });

        // Build keyLookup from paper
        const keyLookup = {};
        if (Array.isArray(paper.answer_key)) {
            paper.answer_key.forEach((ans, i) => {
                if (ans) keyLookup[i + 1] = ans;
            });
        } else if (paper.answerKey) {
            for (let i = 1; i <= (paper.total_questions || paper.numQuestions || 50); i++) {
                const k = (paper.answerKey instanceof Map) ? paper.answerKey.get(String(i)) : paper.answerKey[String(i)];
                if (k) keyLookup[i] = k;
            }
        }

        // Determine sections
        let sectionsDef = [];
        if (Array.isArray(paper.sections) && paper.sections.length > 0) {
            sectionsDef = paper.sections;
        } else {
            const totalQ = paper.total_questions || paper.numQuestions || 50;
            const qPerSec = Math.ceil(totalQ / 4);
            sectionsDef = [
                { name: 'Physics', from_question: 1, to_question: qPerSec, max_marks: qPerSec * 4 },
                { name: 'Chemistry', from_question: qPerSec + 1, to_question: qPerSec * 2, max_marks: qPerSec * 4 },
                { name: 'Botany / Math', from_question: (qPerSec * 2) + 1, to_question: qPerSec * 3, max_marks: qPerSec * 4 },
                { name: 'Zoology / Aptitude', from_question: (qPerSec * 3) + 1, to_question: totalQ, max_marks: (totalQ - (qPerSec * 3)) * 4 }
            ];
        }

        // Dynamically compute sectionWise for each submission without bloating database storage
        results.forEach(r => {
            if (!r.sectionWise || r.sectionWise.length === 0) {
                const resps = Array.isArray(r.responses) ? r.responses : [];
                r.sectionWise = sectionsDef.map(s => {
                    let secCorrect = 0;
                    let secWrong = 0;
                    let secBlank = 0;
                    const fromQ = Number(s.from_question);
                    const toQ = Number(s.to_question);
                    const countInSec = (toQ >= fromQ) ? (toQ - fromQ + 1) : 1;

                    for (let q = fromQ; q <= toQ; q++) {
                        const marked = (resps[q - 1] || '').trim().toUpperCase();
                        const key = (keyLookup[q] || '').trim().toUpperCase();
                        if (!marked) {
                            secBlank++;
                        } else if (key && marked === key) {
                            secCorrect++;
                        } else {
                            secWrong++;
                        }
                    }

                    const secMarks = (secCorrect * 4) - secWrong;
                    return {
                        sectionName: s.name,
                        range: `Q${fromQ}-Q${toQ}`,
                        correct: secCorrect,
                        wrong: secWrong,
                        blank: secBlank,
                        marks: Math.max(0, secMarks),
                        maxMarks: s.max_marks || (countInSec * 4)
                    };
                });
            }
        });

        // Calculate Aggregate Stats
        let highestAggregate = 0;
        let totalAgg = 0;
        let totalPct = 0;
        const maxMarks = paper.max_marks || (paper.numQuestions || 50) * 4;

        // Section averages
        const secSums = {};

        results.forEach(r => {
            const agg = (r.aggregateMarks !== undefined) ? r.aggregateMarks : (r.score * 4);
            if (agg > highestAggregate) highestAggregate = agg;
            totalAgg += agg;
            totalPct += (r.percentage || 0);

            if (r.sectionWise && Array.isArray(r.sectionWise)) {
                r.sectionWise.forEach(s => {
                    if (!secSums[s.sectionName]) {
                        secSums[s.sectionName] = { marks: 0, count: 0, range: s.range, maxMarks: s.maxMarks };
                    }
                    secSums[s.sectionName].marks += s.marks;
                    secSums[s.sectionName].count++;
                });
            }
        });

        const totalCount = results.length;
        const averageAggregate = totalCount > 0 ? Math.round(totalAgg / totalCount) : 0;
        const averageAccuracy = totalCount > 0 ? Math.round(totalPct / totalCount) : 0;

        const sectionAverages = Object.keys(secSums).map(name => {
            const item = secSums[name];
            return {
                sectionName: name,
                range: item.range,
                maxMarks: item.maxMarks,
                avgMarks: Math.round(item.marks / item.count)
            };
        });

        const stats = {
            highestAggregate,
            averageAggregate,
            averageAccuracy,
            maxMarks,
            sectionAverages
        };

        res.render('paper_results', {
            paper,
            results,
            stats,
            answerKeyJson: getAnswerKeyJson(paper)
        });
    } catch (error) {
        console.error('Error loading paper results:', error);
        res.status(500).send('Error loading paper results: ' + error.message);
    }
});
