const mongoose = require('mongoose');
const Paper = require('../models/Paper');
const Submission = require('../models/Submission');
const {
    getAllFolders,
    buildGradedSubmissionObj,
    getSortedGradedPaperResults,
    getGradedSubmissionScore
} = require('./paperService');

// Helper to assemble graded results, rankings, topper stats, and student-scoped folders (count > 0 only)
async function fetchStudentResultsData(req) {
    const isStaff = (req.user.role === 'admin' || req.user.role === 'teacher');
    const targetRoll = isStaff
        ? String(req.query.roll || '').trim()
        : String(req.user.rollnumber || req.user.username || '').trim();

    let results = [];
    const paperTopperStats = {};

    if (targetRoll) {
        const rollVariants = [...new Set([
            targetRoll,
            targetRoll.toUpperCase(),
            targetRoll.toLowerCase()
        ].filter(Boolean))];

        const docs = await Submission.find({
            $or: [
                { rollnumber: { $in: rollVariants } },
                { rollNumber: { $in: rollVariants } }
            ]
        }).sort({ submitted_at: -1, scannedAt: -1 });

        const paperIds = [...new Set(docs.map(d => d.paper_id || d.paperId).filter(Boolean).map(String))];
        const paperQueryIds = [];
        paperIds.forEach(pid => {
            paperQueryIds.push(pid);
            if (mongoose.Types.ObjectId.isValid(pid) && String(new mongoose.Types.ObjectId(pid)) === pid) {
                paperQueryIds.push(new mongoose.Types.ObjectId(pid));
            }
        });

        const papers = paperQueryIds.length > 0
            ? await Paper.find({ _id: { $in: paperQueryIds } })
            : [];
        const papersMap = {};
        papers.forEach(p => {
            papersMap[String(p._id)] = p;
        });

        results = docs.map(doc => {
            const pid = String(doc.paper_id || doc.paperId || '');
            const paper = papersMap[pid] || null;
            return buildGradedSubmissionObj(doc, paper);
        });

        // Compute highest marks overall, subject-wise, and candidate rankings for each paper
        await Promise.all(paperIds.map(async (pid) => {
            const currentPaper = papersMap[pid] || null;
            const sortedPaperResults = await getSortedGradedPaperResults(currentPaper, pid);
            if (sortedPaperResults && sortedPaperResults.length > 0) {
                let highestOverall = -Infinity;
                const sectionHighest = {};
                const rankBySubId = {};
                const rankByRoll = {};

                sortedPaperResults.forEach(graded => {
                    const agg = getGradedSubmissionScore(graded);
                    if (agg > highestOverall) highestOverall = agg;

                    if (Array.isArray(graded.sectionWise)) {
                        graded.sectionWise.forEach(s => {
                            const sName = s.sectionName || 'Section';
                            const m = Number(s.marks || 0);
                            if (!sectionHighest[sName] || m > sectionHighest[sName].highest) {
                                sectionHighest[sName] = {
                                    highest: m,
                                    maxMarks: s.maxMarks || 100
                                };
                            }
                        });
                    }

                    const subId = String(graded._id || graded.id || '');
                    const roll = String(graded.rollnumber || graded.rollNumber || '').trim().toLowerCase();
                    const rankEntry = {
                        rank: graded.rank,
                        position: graded.position,
                        totalCandidates: sortedPaperResults.length
                    };
                    if (subId) rankBySubId[subId] = rankEntry;
                    if (roll && !rankByRoll[roll]) rankByRoll[roll] = rankEntry;
                });

                // Attach rank and totalCandidates to this student's result objects
                results.forEach(r => {
                    const rPid = String(r.paper_id || r.paperId || '');
                    if (rPid === pid) {
                        const subId = String(r._id || r.id || '');
                        const roll = String(r.rollnumber || r.rollNumber || '').trim().toLowerCase();
                        const match = (subId && rankBySubId[subId]) || (roll && rankByRoll[roll]);
                        if (match) {
                            r.rank = match.rank;
                            r.position = match.position;
                            r.totalCandidates = match.totalCandidates;
                        }
                    }
                });

                if (highestOverall === -Infinity) highestOverall = 0;
                paperTopperStats[pid] = {
                    highestOverall,
                    sectionHighest,
                    totalCandidates: sortedPaperResults.length
                };
            }
        }));
    }

    // Filter folders strictly to only those where the student has given tests (count > 0)
    const allFolders = await getAllFolders('all');
    const folderCountMap = {};
    results.forEach(r => {
        const cat = (r.paperCategory || 'General').trim().toLowerCase();
        folderCountMap[cat] = (folderCountMap[cat] || 0) + 1;
    });

    const studentFolders = [];
    const existingFolderNames = new Set();

    allFolders.forEach(f => {
        const count = folderCountMap[f.name.toLowerCase()] || 0;
        if (count > 0) {
            existingFolderNames.add(f.name.toLowerCase());
            studentFolders.push({
                _id: String(f._id),
                name: f.name,
                description: f.description || '',
                examType: f.examType || 'all',
                count
            });
        }
    });

    results.forEach(r => {
        const cat = (r.paperCategory || 'General').trim();
        if (cat && !existingFolderNames.has(cat.toLowerCase())) {
            const count = folderCountMap[cat.toLowerCase()] || 0;
            if (count > 0) {
                existingFolderNames.add(cat.toLowerCase());
                studentFolders.push({
                    _id: cat,
                    name: cat,
                    description: 'Assessment tests & results',
                    examType: r.paperExamType || 'standard',
                    count
                });
            }
        }
    });

    const activeFolder = (req.query.folder || req.query.category || '').trim();

    return {
        results,
        targetRoll,
        paperTopperStats,
        folders: studentFolders,
        activeFolder
    };
}

module.exports = {
    fetchStudentResultsData
};
