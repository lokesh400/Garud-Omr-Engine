const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { fetchStudentResultsData } = require('../services/studentService');

// Student Results Portal (scoped strictly to the signed-in student's roll number, or Admin/Teacher lookup)
router.get('/student', requireAuth, async (req, res) => {
    try {
        const data = await fetchStudentResultsData(req);
        res.render('student_dashboard', data);
    } catch (error) {
        console.error('Error loading student dashboard:', error);
        res.status(500).send('Error loading student results: ' + error.message);
    }
});

// Dedicated Student Performance Analytics & Marks Trends Page
router.get('/student/analytics', requireAuth, async (req, res) => {
    try {
        const data = await fetchStudentResultsData(req);
        res.render('student_analytics', data);
    } catch (error) {
        console.error('Error loading student analytics:', error);
        res.status(500).send('Error loading performance analytics: ' + error.message);
    }
});

// Alias route for /student/charts
router.get('/student/charts', requireAuth, (req, res) => {
    const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect('/student/analytics' + q);
});

module.exports = router;
