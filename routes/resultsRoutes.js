const express = require('express');
const router = express.Router();
const Paper = require('../models/Paper');
const {
    requireAdminOrTeacher,
    validateIdParam
} = require('../middleware/auth');
const {
    getSortedGradedPaperResults,
    buildStudentNameMap,
    getPaperSectionsDef,
    getAnswerKeyJson
} = require('../services/paperService');
const { buildDetailedResultsCsv } = require('../utils/resultsExport');

router.param('id', validateIdParam);

// View All Results & Evaluated OMR Copies for Paper
router.get('/paper/:id/results', requireAdminOrTeacher, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) return res.status(404).send('Paper not found');

        const results = await getSortedGradedPaperResults(paper);
        const studentNameByRoll = await buildStudentNameMap(results);
        results.forEach(r => {
            const roll = String(r.rollnumber || r.rollNumber || '').trim().toLowerCase();
            r.studentName = studentNameByRoll[roll] || '';
        });

        // Calculate Aggregate Stats (aligned with sum of all sections)
        let highestAggregate = 0;
        let totalAgg = 0;
        let totalPct = 0;
        const secDefs = getPaperSectionsDef(paper, paper.numQuestions || 50);
        const computedSecTotalMarks = secDefs.reduce((acc, s) => {
            const fromQ = Number(s.from_question);
            const toQ = Number(s.to_question);
            const qCount = (toQ >= fromQ) ? (toQ - fromQ + 1) : 0;
            return acc + (Number(s.max_marks) || (qCount * 4));
        }, 0);
        const maxMarks = computedSecTotalMarks || paper.max_marks || (paper.numQuestions || 50) * 4;

        // Section averages
        const secSums = {};

        results.forEach(r => {
            const agg = r.allSectionsSummary ? r.allSectionsSummary.obtainedMarks : ((r.aggregateMarks !== undefined) ? r.aggregateMarks : (r.score * 4));
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

// Download Detailed Section-Wise Results CSV (Admin & Teachers)
router.get('/paper/:id/results/export', requireAdminOrTeacher, async (req, res) => {
    try {
        const paperId = req.params.id;
        const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
        if (!paper) return res.status(404).send('Paper not found');

        const results = await getSortedGradedPaperResults(paper);
        const studentNameByRoll = await buildStudentNameMap(results);

        const csv = buildDetailedResultsCsv({ paper, results, studentNameByRoll });
        const safeTitle = String(paper.title || 'Paper').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'Paper';
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_Detailed_Results.csv"`);
        res.send(csv);
    } catch (error) {
        console.error('Error exporting paper results:', error);
        res.status(500).send('Error exporting results: ' + error.message);
    }
});

module.exports = router;
