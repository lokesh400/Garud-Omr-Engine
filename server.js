const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Paper = require('./models/Paper');

require('dotenv').config();

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
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer setup for uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Helper to convert answer key to object
function getAnswerKeyJson(paper) {
    if (!paper || !paper.answerKey) return '{}';
    if (paper.answerKey instanceof Map) {
        return JSON.stringify(Object.fromEntries(paper.answerKey));
    }
    if (typeof paper.answerKey.toObject === 'function') {
        return JSON.stringify(paper.answerKey.toObject());
    }
    return JSON.stringify(paper.answerKey);
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
    const { title, numQuestions } = req.body;
    try {
        const newPaper = new Paper({ title, numQuestions });
        await newPaper.save();
        res.redirect(`/paper/${newPaper._id}`);
    } catch (error) {
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

        const answerKey = {};
        for (let i = 1; i <= paper.numQuestions; i++) {
            if (req.body[`q${i}`]) {
                answerKey[`${i}`] = req.body[`q${i}`];
            }
        }

        paper.answerKey = answerKey;
        await paper.save();
        res.redirect(`/paper/${paper._id}`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error saving answer key: ' + error.message);
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
