function escapeCsvText(value) {
    let str = (value === null || value === undefined) ? '' : String(value);
    // Guard against spreadsheet formula injection for untrusted strings
    if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
    }
    return '"' + str.replace(/"/g, '""') + '"';
}

function escapeCsvNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '0';
    return String(num);
}

function summarizeSections(sectionWise, fallbackTotals = {}) {
    const sections = Array.isArray(sectionWise) ? sectionWise : [];

    if (sections.length === 0) {
        const totalQ = Number(fallbackTotals.totalQuestions) || 0;
        const blank = Number(fallbackTotals.blankCount) || 0;
        const attempted = Math.max(0, totalQ - blank);
        const correct = Number(fallbackTotals.correctCount) || 0;
        const wrong = Number(fallbackTotals.wrongCount) || 0;
        const totalMarks = Number(fallbackTotals.maxMarks) || (totalQ * 4);
        const obtainedMarks = fallbackTotals.aggregateMarks !== undefined
            ? Number(fallbackTotals.aggregateMarks) || 0
            : Math.max(0, (correct * 4) - wrong);

        return {
            normalizedSections: [],
            totals: {
                totalMarks,
                obtainedMarks,
                totalQuestions: totalQ,
                attemptedQuestions: attempted,
                unattemptedQuestions: blank,
                correctCount: correct,
                wrongCount: wrong
            }
        };
    }

    let sumTotalMarks = 0;
    let sumObtainedMarks = 0;
    let sumTotalQuestions = 0;
    let sumAttempted = 0;
    let sumUnattempted = 0;
    let sumCorrect = 0;
    let sumWrong = 0;

    const normalizedSections = sections.map(s => {
        const correct = Number(s.correct) || 0;
        const wrong = Number(s.wrong) || 0;
        const unattempted = s.unattempted !== undefined ? (Number(s.unattempted) || 0) : (Number(s.blank) || 0);
        const totalQuestions = s.totalQuestions !== undefined
            ? (Number(s.totalQuestions) || 0)
            : (s.attempted !== undefined ? ((Number(s.attempted) || 0) + unattempted) : (correct + wrong + unattempted));
        const attempted = s.attempted !== undefined
            ? (Number(s.attempted) || 0)
            : Math.max(0, totalQuestions - unattempted);
        const totalMarks = Number(s.maxMarks) || (totalQuestions * 4);
        const obtainedMarks = Number(s.marks) || 0;

        sumTotalMarks += totalMarks;
        sumObtainedMarks += obtainedMarks;
        sumTotalQuestions += totalQuestions;
        sumAttempted += attempted;
        sumUnattempted += unattempted;
        sumCorrect += correct;
        sumWrong += wrong;

        return {
            sectionName: String(s.sectionName || 'Section'),
            range: String(s.range || ''),
            totalMarks,
            obtainedMarks,
            totalQuestions,
            attemptedQuestions: attempted,
            unattemptedQuestions: unattempted,
            correctCount: correct,
            wrongCount: wrong
        };
    });

    return {
        normalizedSections,
        totals: {
            totalMarks: sumTotalMarks,
            obtainedMarks: sumObtainedMarks,
            totalQuestions: sumTotalQuestions,
            attemptedQuestions: sumAttempted,
            unattemptedQuestions: sumUnattempted,
            correctCount: sumCorrect,
            wrongCount: sumWrong
        }
    };
}

function buildDetailedResultsCsv({ paper, results, studentNameByRoll = {} }) {
    const list = Array.isArray(results) ? results : [];
    const totalQ = (paper && (paper.total_questions || paper.numQuestions)) || 50;

    // Resolve canonical section headers from paper sections or first graded result
    let headerSections = [];
    if (paper && Array.isArray(paper.sections) && paper.sections.length > 0) {
        headerSections = paper.sections.map(s => ({
            sectionName: s.name || 'Section',
            range: (s.from_question && s.to_question) ? `Q${s.from_question}-Q${s.to_question}` : ''
        }));
    } else if (list.length > 0 && Array.isArray(list[0].sectionWise) && list[0].sectionWise.length > 0) {
        headerSections = list[0].sectionWise.map(s => ({
            sectionName: s.sectionName || 'Section',
            range: s.range || ''
        }));
    } else {
        const qPerSec = Math.ceil(totalQ / 4);
        const defs = [
            { sectionName: 'Physics', fromQ: 1, toQ: qPerSec },
            { sectionName: 'Chemistry', fromQ: qPerSec + 1, toQ: qPerSec * 2 },
            { sectionName: 'Botany / Math', fromQ: (qPerSec * 2) + 1, toQ: qPerSec * 3 },
            { sectionName: 'Zoology / Aptitude', fromQ: (qPerSec * 3) + 1, toQ: totalQ }
        ].filter(d => d.toQ >= d.fromQ);
        headerSections = defs.map(d => ({
            sectionName: d.sectionName,
            range: `Q${d.fromQ}-Q${d.toQ}`
        }));
    }

    const headers = ['Rank', 'Roll Number', 'Student Name'];

    headerSections.forEach(sec => {
        const prefix = sec.range ? `${sec.sectionName} (${sec.range})` : sec.sectionName;
        headers.push(
            `${prefix} Total Marks`,
            `${prefix} Obtained Marks`,
            `${prefix} Total Questions`,
            `${prefix} Attempted Questions`,
            `${prefix} Unattempted Questions`,
            `${prefix} Correct`,
            `${prefix} Wrong`
        );
    });

    headers.push(
        'All Sections Total Marks',
        'All Sections Obtained Marks',
        'All Sections Total Questions',
        'All Sections Attempted Questions',
        'All Sections Unattempted Questions',
        'All Sections Correct',
        'All Sections Wrong',
        'Overall Accuracy (%)',
        'Scanned At'
    );

    const lines = [headers.map(h => escapeCsvText(h)).join(',')];

    list.forEach((item, idx) => {
        const roll = String(item.rollnumber || item.rollNumber || 'UNKNOWN').trim();
        const studentName = studentNameByRoll[roll.toLowerCase()] || '';
        const { normalizedSections, totals } = summarizeSections(item.sectionWise, {
            totalQuestions: item.totalQuestions || totalQ,
            correctCount: item.correctCount,
            wrongCount: item.wrongCount,
            blankCount: item.blankCount,
            maxMarks: item.maxMarks,
            aggregateMarks: item.aggregateMarks
        });

        const scannedDate = item.submitted_at || item.scannedAt;
        const formattedDate = scannedDate ? new Date(scannedDate).toLocaleString('en-IN') : '';

        const rowCells = [
            escapeCsvNumber(idx + 1),
            escapeCsvText(roll),
            escapeCsvText(studentName)
        ];

        headerSections.forEach((hdrSec, sIdx) => {
            const matched = normalizedSections[sIdx] || {
                totalMarks: 0,
                obtainedMarks: 0,
                totalQuestions: 0,
                attemptedQuestions: 0,
                unattemptedQuestions: 0,
                correctCount: 0,
                wrongCount: 0
            };

            rowCells.push(
                escapeCsvNumber(matched.totalMarks),
                escapeCsvNumber(matched.obtainedMarks),
                escapeCsvNumber(matched.totalQuestions),
                escapeCsvNumber(matched.attemptedQuestions),
                escapeCsvNumber(matched.unattemptedQuestions),
                escapeCsvNumber(matched.correctCount),
                escapeCsvNumber(matched.wrongCount)
            );
        });

        rowCells.push(
            escapeCsvNumber(totals.totalMarks),
            escapeCsvNumber(totals.obtainedMarks),
            escapeCsvNumber(totals.totalQuestions),
            escapeCsvNumber(totals.attemptedQuestions),
            escapeCsvNumber(totals.unattemptedQuestions),
            escapeCsvNumber(totals.correctCount),
            escapeCsvNumber(totals.wrongCount),
            escapeCsvNumber(item.percentage !== undefined ? item.percentage : 0),
            escapeCsvText(formattedDate)
        );

        lines.push(rowCells.join(','));
    });

    // UTF-8 BOM ensures Excel opens student names & headers cleanly
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

module.exports = {
    summarizeSections,
    buildDetailedResultsCsv
};

