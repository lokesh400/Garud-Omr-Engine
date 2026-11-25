const express = require('express');
const router = express.Router();
const Paper = require('../models/Paper');
const Submission = require('../models/Submission');
const Folder = require('../models/Folder');
const {
    requireAuth,
    requireAdmin,
    requireAdminOrTeacher,
    validateIdParam
} = require('../middleware/auth');
const {
    getAllFolders,
    deletePaperAndAllSubmissions,
    regradePaperSubmissions
} = require('../services/paperService');
const { recheckSubmissionFromCloudinary } = require('../utils/omrEvaluator');

router.param('id', validateIdParam);

// Dashboard & Paper Routes
router.get('/', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
        return res.redirect('/student');
    }
    try {
        const query = {
            exam_type: { $ne: 'jee' },
            title: { $not: /jee/i },
            subject: { $not: /jee/i }
        };
        const papers = await Paper.find(query).sort({ createdAt: -1 });
        const allFolders = await getAllFolders('standard');

        const folderCounts = {};
        papers.forEach(p => {
            const cat = (p.category || p.batch || 'General').trim().toLowerCase();
            folderCounts[cat] = (folderCounts[cat] || 0) + 1;
        });

        const foldersWithCounts = allFolders.map(f => ({
            _id: f._id,
            name: f.name,
            description: f.description || '',
            examType: f.examType || 'standard',
            count: folderCounts[f.name.toLowerCase()] || 0
        }));

        const categories = allFolders.map(f => f.name);
        const activeFolder = (req.query.category || req.query.folder || '').trim();
        res.render('index', { papers, categories, folders: foldersWithCounts, activeFolder });
    } catch (e) {
        res.status(500).send('Error loading papers: ' + e.message);
    }
});

router.get('/paper/new', requireAdmin, async (req, res) => {
    try {
        const allFolders = await getAllFolders('standard');
        const categories = allFolders.map(f => f.name);
        const selectedFolder = (req.query.category || req.query.folder || '').trim();
        res.render('create_paper', { categories, folders: allFolders, selectedFolder });
    } catch (e) {
        res.render('create_paper', { categories: [], folders: [], selectedFolder: '' });
    }
});

router.post('/paper/new', requireAdmin, async (req, res) => {
    try {
        const {
            paper_id,
            id,
            title,
            subject,
            category,
            batch,
            section_category,
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

        const catVal = (category || batch || section_category || 'General').trim() || 'General';

        const paperData = {
            title: title ? title.trim() : 'Untitled Paper',
            subject: subject ? subject.trim() : 'General',
            category: catVal,
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

// Delete Entire Paper + All its Submissions & Cloudinary OMR Images
router.delete('/api/paper/:id', requireAdmin, async (req, res) => {
    try {
        const result = await deletePaperAndAllSubmissions(req.params.id);
        res.json({
            success: true,
            message: `Paper "${result.title}" and all ${result.deletedSubmissionsCount} submission(s) deleted successfully.`,
            ...result
        });
    } catch (err) {
        console.error('Error deleting paper:', err);
        res.status(err.message === 'Paper not found' ? 404 : 500).json({ error: err.message });
    }
});

router.post('/paper/:id/delete', requireAdmin, async (req, res) => {
    try {
        const result = await deletePaperAndAllSubmissions(req.params.id);
        const redirectUrl = (result.exam_type === 'jee' || /jee/i.test(result.title || '')) ? '/jee' : '/';
        res.redirect(`${redirectUrl}?message=${encodeURIComponent(`Paper "${result.title}" and ${result.deletedSubmissionsCount} submission(s) deleted successfully.`)}`);
    } catch (err) {
        console.error('Error deleting paper:', err);
        res.status(500).send('Error deleting paper: ' + err.message);
    }
});

// Section / Batch / Folder APIs (Staff only)
router.get('/api/folders', requireAdminOrTeacher, async (req, res) => {
    try {
        const filterType = (req.query.examType || req.query.type || 'all').toLowerCase();
        const allFolders = await getAllFolders(filterType);
        const counts = await Paper.aggregate([
            { $group: { _id: '$category', count: { $sum: 1 } } }
        ]);
        const countMap = {};
        counts.forEach(c => {
            if (c._id) countMap[String(c._id).trim().toLowerCase()] = c.count;
        });
        const result = allFolders.map(f => ({
            _id: f._id,
            name: f.name,
            description: f.description || '',
            examType: f.examType || 'standard',
            count: countMap[f.name.toLowerCase()] || 0
        }));
        res.json({ success: true, folders: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create New Section / Batch / Folder (Admin only)
router.post('/api/folders', requireAdmin, async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Folder name cannot be empty' });
        const existing = await Folder.findOne({ name: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
        if (existing) {
            return res.status(400).json({ error: `Section / Batch / Folder "${existing.name}" already exists.` });
        }
        const examType = req.body.examType ? String(req.body.examType).trim() : (/jee/i.test(name) ? 'jee' : 'standard');
        const folder = await Folder.create({
            name,
            description: String(req.body.description || '').trim(),
            examType
        });
        res.json({ success: true, folder: { _id: folder._id, name: folder.name, description: folder.description, examType: folder.examType, count: 0 } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a Section / Batch / Folder (Admin only)
router.delete('/api/folders/:id', requireAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const folder = await Folder.findById(id) || await Folder.findOne({ _id: id }) || await Folder.findOne({ name: id });
        if (!folder) return res.status(404).json({ error: 'Folder not found' });
        await Folder.findByIdAndDelete(folder._id);
        res.json({ success: true, message: `Folder "${folder.name}" deleted.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update / Edit Section / Batch / Folder (Admin only)
async function handleFolderUpdate(req, res) {
    try {
        const id = req.params.id;
        const folder = await Folder.findById(id) || await Folder.findOne({ _id: id }) || await Folder.findOne({ name: id });
        if (!folder) return res.status(404).json({ error: 'Folder not found' });

        const newName = String(req.body.name || '').trim();
        if (!newName) return res.status(400).json({ error: 'Folder name cannot be empty' });

        const oldName = folder.name;
        if (newName.toLowerCase() !== oldName.toLowerCase()) {
            const existing = await Folder.findOne({
                _id: { $ne: folder._id },
                name: new RegExp('^' + newName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')
            });
            if (existing) {
                return res.status(400).json({ error: `Folder "${existing.name}" already exists.` });
            }
        }

        folder.name = newName;
        if (req.body.description !== undefined) {
            folder.description = String(req.body.description || '').trim();
        }
        if (req.body.examType) {
            folder.examType = String(req.body.examType).trim();
        }
        await folder.save();

        // Update all papers currently in this folder so their category aligns with new folder name
        if (oldName !== newName) {
            await Paper.updateMany(
                { category: new RegExp('^' + oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') },
                { category: newName }
            );
        }

        res.json({
            success: true,
            message: `Folder updated successfully.`,
            folder: {
                _id: folder._id,
                name: folder.name,
                description: folder.description,
                examType: folder.examType
            },
            oldName,
            newName
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}
router.put('/api/folders/:id', requireAdmin, handleFolderUpdate);
router.post('/api/folders/:id/edit', requireAdmin, handleFolderUpdate);

// Migrate Paper to another Section / Batch / Folder
router.post('/api/paper/:id/migrate', requireAdmin, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id) || await Paper.findOne({ _id: decodeURIComponent(req.params.id) });
        if (!paper) return res.status(404).json({ error: 'Paper not found' });
        const targetFolder = String(req.body.targetFolder || req.body.category || '').trim();
        if (!targetFolder) return res.status(400).json({ error: 'Please select a valid Section / Batch / Folder' });

        const existing = await Folder.findOne({ name: new RegExp('^' + targetFolder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
        if (!existing) {
            await Folder.create({ name: targetFolder });
        }

        paper.category = targetFolder;
        await paper.save();
        res.json({ success: true, category: targetFolder, message: `Paper migrated to ${targetFolder} successfully.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update Paper Category / Section / Batch (backward compatibility)
router.post('/api/paper/:id/category', requireAdmin, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id) || await Paper.findOne({ _id: decodeURIComponent(req.params.id) });
        if (!paper) return res.status(404).json({ error: 'Paper not found' });
        const newCategory = String(req.body.category || req.body.targetFolder || 'General').trim() || 'General';
        const existing = await Folder.findOne({ name: new RegExp('^' + newCategory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
        if (!existing) {
            await Folder.create({ name: newCategory });
        }
        paper.category = newCategory;
        await paper.save();
        res.json({ success: true, category: newCategory });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get single paper details as JSON (Staff only)
router.get('/api/paper/:id', requireAdminOrTeacher, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id) || await Paper.findOne({ _id: decodeURIComponent(req.params.id) });
        if (!paper) return res.status(404).json({ error: 'Paper not found' });
        res.json({
            success: true,
            paper: {
                _id: paper._id,
                title: paper.title,
                subject: paper.subject || 'General',
                category: paper.category || paper.batch || 'General',
                total_questions: paper.total_questions || paper.numQuestions || 50,
                max_marks: paper.max_marks || ((paper.total_questions || 50) * 4),
                sections: paper.sections || [],
                exam_type: paper.exam_type || 'standard'
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update / Edit Paper Details (Title, Subject, Category, Total Questions, Max Marks, Sections)
async function handlePaperUpdate(req, res) {
    try {
        const paper = await Paper.findById(req.params.id) || await Paper.findOne({ _id: decodeURIComponent(req.params.id) });
        if (!paper) return res.status(404).json({ error: 'Paper not found' });

        const {
            title,
            subject,
            category,
            batch,
            targetFolder,
            total_questions,
            numQuestions,
            max_marks,
            sections
        } = req.body;

        if (title !== undefined) {
            const cleanTitle = String(title).trim();
            if (!cleanTitle) return res.status(400).json({ error: 'Paper title cannot be empty' });
            paper.title = cleanTitle;
        }

        if (subject !== undefined) {
            paper.subject = String(subject).trim() || 'General';
        }

        const catVal = String(category || batch || targetFolder || '').trim();
        if (catVal) {
            const existing = await Folder.findOne({ name: new RegExp('^' + catVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
            if (!existing) {
                await Folder.create({ name: catVal });
            }
            paper.category = catVal;
        }

        let newTotalQ = paper.total_questions || paper.numQuestions || 50;
        if (total_questions !== undefined || numQuestions !== undefined) {
            const parsedQ = Number(total_questions || numQuestions);
            if (!isNaN(parsedQ) && parsedQ >= 1 && parsedQ <= 200) {
                newTotalQ = parsedQ;
                paper.total_questions = newTotalQ;
            }
        }

        // Process sections if provided
        if (sections !== undefined) {
            let parsedSections = [];
            if (typeof sections === 'string' && sections.trim() !== '') {
                try {
                    parsedSections = JSON.parse(sections);
                } catch (e) {
                    return res.status(400).json({ error: 'Invalid sections format: ' + e.message });
                }
            } else if (Array.isArray(sections)) {
                parsedSections = sections;
            }

            const sanitizedSections = parsedSections.map((sec, idx) => {
                const fromQ = Math.max(1, parseInt(sec.from_question || sec.from || 1, 10));
                const toQ = Math.max(fromQ, parseInt(sec.to_question || sec.to || fromQ, 10));
                const count = toQ - fromQ + 1;
                const secMax = (sec.max_marks !== undefined && sec.max_marks !== null && sec.max_marks !== '')
                    ? Number(sec.max_marks)
                    : (count * 4);
                return {
                    name: String(sec.name || `Section ${idx + 1}`).trim(),
                    from_question: fromQ,
                    to_question: toQ,
                    max_marks: secMax
                };
            });

            paper.sections = sanitizedSections;

            let sumSecMarks = 0;
            sanitizedSections.forEach(s => sumSecMarks += (Number(s.max_marks) || 0));
            if (sumSecMarks > 0) {
                paper.max_marks = sumSecMarks;
            } else if (max_marks !== undefined && !isNaN(Number(max_marks))) {
                paper.max_marks = Number(max_marks);
            } else {
                paper.max_marks = newTotalQ * 4;
            }
        } else if (max_marks !== undefined && !isNaN(Number(max_marks))) {
            paper.max_marks = Number(max_marks);
        }

        await paper.save();

        res.json({
            success: true,
            message: `Paper "${paper.title}" updated successfully.`,
            paper: {
                _id: paper._id,
                title: paper.title,
                subject: paper.subject,
                category: paper.category,
                total_questions: paper.total_questions,
                max_marks: paper.max_marks,
                sections: paper.sections
            }
        });
    } catch (err) {
        console.error('Error updating paper:', err);
        res.status(500).json({ error: err.message });
    }
}
router.put('/api/paper/:id', requireAdmin, handlePaperUpdate);
router.post('/api/paper/:id/edit', requireAdmin, handlePaperUpdate);

router.get('/paper/:id', requireAdminOrTeacher, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id) || await Paper.findOne({ _id: decodeURIComponent(req.params.id) });
        if (!paper) return res.status(404).send('Paper not found');
        res.render('paper_detail', { paper, saved: req.query.saved === 'true' });
    } catch (error) {
        res.status(500).send('Error loading paper: ' + error.message);
    }
});

// Dedicated JEE Mains Portal Dashboard
router.get('/jee', requireAdminOrTeacher, async (req, res) => {
    try {
        const allPapers = await Paper.find({}).sort({ createdAt: -1 });
        const jeePapers = allPapers.filter(p =>
            (p.exam_type === 'jee') ||
            /jee/i.test(p.title || '') ||
            /jee/i.test(p.subject || '')
        );

        // Fetch submission counts for each JEE paper
        const paperIds = jeePapers.map(p => String(p._id));
        const subCounts = {};
        if (paperIds.length > 0) {
            const counts = await Submission.aggregate([
                { $match: { paper_id: { $in: paperIds } } },
                { $group: { _id: '$paper_id', count: { $sum: 1 } } }
            ]);
            counts.forEach(c => { subCounts[String(c._id)] = c.count; });
        }

        const allFolders = await getAllFolders('jee');
        const folderCounts = {};
        jeePapers.forEach(p => {
            const cat = (p.category || p.batch || '12th JEE').trim().toLowerCase();
            folderCounts[cat] = (folderCounts[cat] || 0) + 1;
        });

        const foldersWithCounts = allFolders.map(f => ({
            _id: f._id,
            name: f.name,
            description: f.description || '',
            count: folderCounts[f.name.toLowerCase()] || 0
        }));

        const categories = allFolders.map(f => f.name);
        const activeFolder = (req.query.category || req.query.folder || '').trim();

        res.render('jee_dashboard', { papers: jeePapers, allPapers, subCounts, categories, folders: foldersWithCounts, activeFolder });
    } catch (error) {
        res.status(500).send('Error loading JEE Mains portal: ' + error.message);
    }
});

// Create New JEE Mains Paper Form
router.get('/jee/new', requireAdmin, async (req, res) => {
    try {
        const allFolders = await getAllFolders('jee');
        const categories = allFolders.map(f => f.name);
        const selectedFolder = (req.query.category || req.query.folder || '12th JEE').trim();
        res.render('create_jee_paper', { categories, folders: allFolders, selectedFolder });
    } catch (e) {
        res.render('create_jee_paper', { categories: [], folders: [], selectedFolder: '12th JEE' });
    }
});

// Process New JEE Mains Paper Creation
router.post('/jee/new', requireAdmin, async (req, res) => {
    try {
        const title = (req.body.title || 'JEE Mains Exam').trim();
        const category = (req.body.category || req.body.batch || req.body.section_category || '12th JEE').trim() || '12th JEE';
        const paper = new Paper({
            title: title,
            subject: 'JEE Mains',
            category: category,
            total_questions: 100,
            max_marks: 300,
            exam_type: 'jee',
            sections: [
                { name: 'Physics', from_question: 1, to_question: 25, max_marks: 100 },
                { name: 'Chemistry', from_question: 26, to_question: 50, max_marks: 100 },
                { name: 'Mathematics', from_question: 51, to_question: 75, max_marks: 100 }
            ],
            answer_key: new Array(100).fill(null)
        });
        await paper.save();
        res.redirect(`/paper/${encodeURIComponent(paper._id)}/jee-answerkey`);
    } catch (error) {
        res.status(500).send('Error creating JEE Mains paper: ' + error.message);
    }
});

// Dedicated JEE Mains Answer Key Page (Shows only Q1-20, Q41-60, Q81-100 divided into 3 sections)
router.get('/paper/:id/jee-answerkey', requireAdminOrTeacher, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id) || await Paper.findOne({ _id: decodeURIComponent(req.params.id) });
        if (!paper) return res.status(404).send('Paper not found');
        res.render('jee_answerkey', { paper, saved: req.query.saved === 'true' });
    } catch (error) {
        res.status(500).send('Error loading JEE answer key: ' + error.message);
    }
});

// Save JEE Mains Answer Key
router.post('/paper/:id/jee-answerkey', requireAdmin, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) return res.status(404).send('Paper not found');

        const currentTotal = paper.total_questions || paper.numQuestions || 50;
        const newTotalQ = Math.max(100, currentTotal);
        paper.total_questions = newTotalQ;

        // Clone or create array with enough length for Q1-100
        const answerKeyArr = new Array(newTotalQ).fill(null);
        if (Array.isArray(paper.answer_key)) {
            for (let i = 0; i < paper.answer_key.length && i < newTotalQ; i++) {
                answerKeyArr[i] = paper.answer_key[i];
            }
        }

        // Section 1: Physics Q1-20
        for (let i = 1; i <= 20; i++) {
            const val = req.body[`q${i}`];
            answerKeyArr[i - 1] = (val && typeof val === 'string' && val.trim() !== '') ? val.trim().toUpperCase() : null;
        }

        // Section 2: Chemistry Q41-60
        for (let i = 41; i <= 60; i++) {
            const val = req.body[`q${i}`];
            answerKeyArr[i - 1] = (val && typeof val === 'string' && val.trim() !== '') ? val.trim().toUpperCase() : null;
        }

        // Section 3: Mathematics Q81-100
        for (let i = 81; i <= 100; i++) {
            const val = req.body[`q${i}`];
            answerKeyArr[i - 1] = (val && typeof val === 'string' && val.trim() !== '') ? val.trim().toUpperCase() : null;
        }

        paper.answer_key = answerKeyArr;
        await paper.save();

        // Automatically recheck all previously scanned OMR submissions against the updated key
        await regradePaperSubmissions(paper);

        res.redirect(`/paper/${encodeURIComponent(paper._id)}/jee-answerkey?saved=true`);
    } catch (error) {
        console.error('Error saving JEE answer key:', error);
        res.status(500).send('Error saving JEE answer key: ' + error.message);
    }
});

router.get('/paper/:id/omr', requireAdmin, async (req, res) => {
    try {
        const paper = await Paper.findById(req.params.id);
        if (!paper) return res.status(404).send('Paper not found');
        res.render('omr_sheet', { paper });
    } catch (error) {
        res.status(500).send('Error loading OMR sheet: ' + error.message);
    }
});

router.post('/paper/:id/answerkey', requireAdmin, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
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

        // Automatically recheck all previously scanned OMR submissions against the updated key
        await regradePaperSubmissions(paper);

        res.redirect(`/paper/${encodeURIComponent(paper._id)}?saved=true`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error saving answer key: ' + error.message);
    }
});

// Explicit API endpoint to recheck/regrade all OMR submissions for a paper against its current answer key
router.post('/api/paper/:id/recheck', requireAdmin, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) return res.status(404).json({ error: 'Paper not found' });

        const recheckedCount = await regradePaperSubmissions(paper);
        res.json({ success: true, recheckedCount });
    } catch (error) {
        console.error('Error rechecking submissions:', error);
        res.status(500).json({ error: error.message });
    }
});

// Hard Recheck Endpoint: extracts OMR sheets from Cloudinary one by one and re-evaluates them from scratch
router.post('/api/paper/:id/hard-recheck', requireAdmin, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) return res.status(404).json({ error: 'Paper not found' });

        const paperIdStr = String(paper._id);
        const submissions = await Submission.find({
            $or: [
                { paper_id: paperIdStr },
                { paper_id: paper._id },
                { paperId: paper._id }
            ]
        }).sort({ submitted_at: 1 });

        const isStream = req.headers.accept && req.headers.accept.includes('text/event-stream');

        if (isStream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            if (typeof res.flushHeaders === 'function') {
                res.flushHeaders();
            }

            const sendEvent = (data) => {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };

            sendEvent({
                type: 'start',
                total: submissions.length,
                paperTitle: paper.title
            });

            if (submissions.length === 0) {
                sendEvent({ type: 'done', total: 0, processed: 0, results: [] });
                return res.end();
            }

            const results = [];
            for (let i = 0; i < submissions.length; i++) {
                const sub = submissions[i];
                const roll = sub.rollnumber || sub.rollNumber || 'UNKNOWN';

                sendEvent({
                    type: 'progress',
                    current: i + 1,
                    total: submissions.length,
                    roll: roll,
                    status: `Extracting OMR sheet ${i + 1} of ${submissions.length} from Cloudinary (Roll: ${roll})...`
                });

                try {
                    const outcome = await recheckSubmissionFromCloudinary(sub, paper);
                    const resItem = {
                        id: sub._id,
                        roll: outcome.evaluated.rollnumber,
                        score: outcome.evaluated.score,
                        maxMarks: outcome.evaluated.maxMarks,
                        correctCount: outcome.evaluated.correctCount,
                        wrongCount: outcome.evaluated.wrongCount,
                        blankCount: outcome.evaluated.blankCount,
                        mcqSubjectScores: outcome.evaluated.mcqSubjectScores,
                        success: true
                    };
                    results.push(resItem);

                    sendEvent({
                        type: 'sheet_done',
                        current: i + 1,
                        total: submissions.length,
                        roll: outcome.evaluated.rollnumber,
                        score: outcome.evaluated.score,
                        maxMarks: outcome.evaluated.maxMarks,
                        correctCount: outcome.evaluated.correctCount,
                        wrongCount: outcome.evaluated.wrongCount,
                        blankCount: outcome.evaluated.blankCount,
                        mcqSubjectScores: outcome.evaluated.mcqSubjectScores,
                        status: `✓ Sheet ${i + 1}/${submissions.length} re-scanned: Roll ${outcome.evaluated.rollnumber} → ${outcome.evaluated.score}/${outcome.evaluated.maxMarks} Marks`
                    });
                } catch (subErr) {
                    console.error(`[Hard Recheck Error] Failed to re-scan submission ${sub._id}:`, subErr);
                    results.push({
                        id: sub._id,
                        roll: roll,
                        error: subErr.message,
                        success: false
                    });
                    sendEvent({
                        type: 'sheet_error',
                        current: i + 1,
                        total: submissions.length,
                        roll: roll,
                        error: subErr.message,
                        status: `⚠ Sheet ${i + 1}/${submissions.length} (Roll ${roll}) failed: ${subErr.message}`
                    });
                }
            }

            sendEvent({
                type: 'done',
                total: submissions.length,
                processed: results.filter(r => r.success).length,
                results
            });

            return res.end();
        }

        // Standard JSON response fallback
        const results = [];
        for (const sub of submissions) {
            try {
                const outcome = await recheckSubmissionFromCloudinary(sub, paper);
                results.push({
                    id: sub._id,
                    roll: outcome.evaluated.rollnumber,
                    score: outcome.evaluated.score,
                    maxMarks: outcome.evaluated.maxMarks,
                    success: true
                });
            } catch (err) {
                results.push({
                    id: sub._id,
                    roll: sub.rollnumber,
                    error: err.message,
                    success: false
                });
            }
        }

        res.json({
            success: true,
            total: submissions.length,
            processed: results.filter(r => r.success).length,
            results
        });

    } catch (error) {
        console.error('Hard recheck error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
            res.end();
        }
    }
});

// Update or configure sections for a paper
router.post('/paper/:id/sections', requireAdmin, async (req, res) => {
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

module.exports = router;
