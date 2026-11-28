const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const Paper = require('../models/Paper');
const Submission = require('../models/Submission');
const User = require('../models/User');
const { getSortedGradedPaperResults, buildStudentNameMap } = require('./paperService');

// In-memory store for active and recent WhatsApp dispatch jobs
const dispatchJobs = new Map();

// Helper to keep job history clean (max 50 recent jobs)
function pruneOldJobs() {
    if (dispatchJobs.size > 50) {
        const oldestKeys = [...dispatchJobs.keys()].slice(0, dispatchJobs.size - 50);
        oldestKeys.forEach(k => dispatchJobs.delete(k));
    }
}

/**
 * Sends a cryptographically signed HMAC-SHA256 request to the WhatsApp Server
 */
async function postSignedToWhatsAppServer(endpoint, payload) {
    const serverUrl = process.env.WHATSAPP_SERVER_URL || 'https://garud-whatsapp-server.onrender.com';
    const apiKey = process.env.WHATSAPP_API_KEY || '';
    const hmacSecret = process.env.WHATSAPP_HMAC_SECRET || '';

    const parsedUrl = new URL(endpoint, serverUrl);
    const postData = JSON.stringify(payload);
    const timestamp = Date.now().toString();

    // Compute HMAC-SHA256 signature over timestamp.payload
    const signature = crypto
        .createHmac('sha256', hmacSecret)
        .update(`${timestamp}.${postData}`)
        .digest('hex');

    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'x-api-key': apiKey,
        'x-timestamp': timestamp,
        'x-signature': signature
    };

    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    return new Promise((resolve, reject) => {
        const req = transport.request(parsedUrl, {
            method: 'POST',
            headers,
            timeout: 20000
        }, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                let parsed;
                try {
                    parsed = JSON.parse(body);
                } catch (_) {
                    parsed = { raw: body };
                }

                if (res.statusCode >= 200 && res.statusCode < 300 && (parsed.success !== false)) {
                    return resolve(parsed);
                }
                const errMsg = parsed.message || parsed.error || `HTTP ${res.statusCode}`;
                reject(new Error(errMsg));
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('WhatsApp server connection timed out (20s).'));
        });

        req.on('error', (err) => {
            reject(new Error(`WhatsApp server network error: ${err.message}`));
        });

        req.write(postData);
        req.end();
    });
}

/**
 * Formats a WhatsApp scorecard message for a student
 */
function formatStudentWhatsAppMessage(studentResult, paper, rank, totalStudents) {
    const name = studentResult.studentName || 'Student';
    const roll = studentResult.rollnumber || studentResult.rollNumber || 'N/A';
    const title = paper.title || 'Examination';
    const examType = (paper.exam_type === 'jee' || studentResult.examType === 'jee') ? 'JEE Mains' : (paper.subject || 'Standard Test');

    const score = studentResult.allSectionsSummary
        ? studentResult.allSectionsSummary.obtainedMarks
        : (studentResult.aggregateMarks !== undefined ? studentResult.aggregateMarks : studentResult.score);

    const maxMarks = studentResult.maxMarks || (paper.max_marks || (paper.numQuestions * 4));
    const pct = studentResult.percentage !== undefined ? Number(studentResult.percentage).toFixed(1) : ((score / maxMarks) * 100).toFixed(1);

    const correct = studentResult.correctCount !== undefined ? studentResult.correctCount : 0;
    const wrong = studentResult.wrongCount !== undefined ? studentResult.wrongCount : 0;
    const blank = studentResult.blankCount !== undefined ? studentResult.blankCount : 0;

    let secText = '';
    if (Array.isArray(studentResult.sectionWise) && studentResult.sectionWise.length > 0) {
        secText = studentResult.sectionWise.map(s => {
            return `  • *${s.sectionName}:* ${s.marks} / ${s.maxMarks} (✓ ${s.correct} | ✗ ${s.wrong} | ○ ${s.blank})`;
        }).join('\n');
    }

    const omrLink = studentResult.cloudinary_image_url || studentResult.omrImageUrl || '';

    return `🦅 *GARUD CLASSES*
📊 *Official Student Examination Result*
━━━━━━━━━━━━━━━━━━━━━
Dear Parent,
Here is the official performance report of your ward:

👤 *Student Name:* ${name}
🆔 *Roll Number:* ${roll}
📝 *Exam Paper:* ${title} (${examType})

🎯 *Total Score:* ${score} / ${maxMarks} (${pct}%)
🏆 *Class Rank:* #${rank} of ${totalStudents}

✅ *Correct Answers:* ${correct}
❌ *Wrong Answers:* ${wrong}
⚪ *Unattempted:* ${blank}
${secText ? `\n📚 *Subject-wise Marks:*\n${secText}\n` : ''}
${omrLink ? `📄 *Evaluated OMR Sheet:*\n${omrLink}\n` : ''}━━━━━━━━━━━━━━━━━━━━━
_Garud Classes — Learn Today, Lead Tomorrow_
🌐 garudclasses.com`;
}

/**
 * Starts an asynchronous background WhatsApp dispatch job
 */
async function startWhatsAppDispatchJob(paperId, initiatorUser) {
    const paper = await Paper.findById(paperId) || await Paper.findOne({ _id: decodeURIComponent(paperId) });
    if (!paper) {
        throw new Error('Paper not found.');
    }

    const results = await getSortedGradedPaperResults(paper);
    if (!results || results.length === 0) {
        throw new Error('No evaluated student submissions found for this paper.');
    }

    const studentNameByRoll = await buildStudentNameMap(results);
    results.forEach(r => {
        const roll = String(r.rollnumber || r.rollNumber || '').trim().toLowerCase();
        r.studentName = studentNameByRoll[roll] || r.studentName || '';
    });

    // Fetch phone numbers from User collection
    const rollVariants = [];
    results.forEach(r => {
        const roll = String(r.rollnumber || r.rollNumber || '').trim();
        if (roll) {
            rollVariants.push(roll, roll.toUpperCase(), roll.toLowerCase());
        }
    });

    const uniqueRolls = [...new Set(rollVariants.filter(Boolean))];
    const userDocs = await User.find({
        $or: [
            { rollnumber: { $in: uniqueRolls } },
            { username: { $in: uniqueRolls.map(r => r.toLowerCase()) } }
        ]
    }, 'username rollnumber fullName parentPhone').lean();

    const parentContactMap = {};
    userDocs.forEach(u => {
        const p = u.parentPhone ? String(u.parentPhone).trim() : '';
        if (u.rollnumber) parentContactMap[String(u.rollnumber).trim().toLowerCase()] = p;
        if (u.username) parentContactMap[String(u.username).trim().toLowerCase()] = p;
    });

    // Create Unique Job ID
    const jobId = 'wajob_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
    const job = {
        id: jobId,
        paperId: String(paper._id),
        paperTitle: paper.title,
        total: results.length,
        sent: 0,
        failed: 0,
        skipped: 0,
        status: 'running',
        currentStudent: null,
        startTime: Date.now(),
        completedTime: null,
        logs: [],
        initiatedBy: (initiatorUser && initiatorUser.username) || 'admin'
    };

    dispatchJobs.set(jobId, job);
    pruneOldJobs();

    // Launch background asynchronous dispatch loop without awaiting
    runDispatchLoop(job, results, parentContactMap, paper).catch(err => {
        console.error(`[WhatsApp Dispatch Job ${jobId}] Fatal Error:`, err);
        job.status = 'failed';
        job.completedTime = Date.now();
        job.logs.push(`[Fatal] Job stopped unexpectedly: ${err.message}`);
    });

    return job;
}

/**
 * Background loop executing rate-limited student dispatch with humanized jitter
 */
async function runDispatchLoop(job, results, parentContactMap, paper) {
    const totalStudents = results.length;

    for (let i = 0; i < results.length; i++) {
        // Allow administrator to cancel job mid-flight
        if (job.status === 'cancelled') {
            job.logs.push('⛔ Dispatch cancelled by administrator.');
            break;
        }

        const r = results[i];
        const rank = i + 1;
        const roll = String(r.rollnumber || r.rollNumber || '').trim();
        const lowRoll = roll.toLowerCase();
        const name = r.studentName || `Roll ${roll}`;

        // Resolve parent phone number strictly
        let phone = r.parentPhone || parentContactMap[lowRoll] || '';
        phone = String(phone).replace(/\D/g, '');

        if (!phone || phone.length < 10) {
            job.skipped++;
            job.logs.push(`⚠️ Skipped ${name} (Roll: ${roll}): No valid 10-digit Parent WhatsApp number on file.`);
            continue;
        }

        job.currentStudent = {
            index: i + 1,
            name,
            roll,
            parentPhone: phone.slice(-4).padStart(phone.length, '•')
        };

        const messageText = formatStudentWhatsAppMessage(r, paper, rank, totalStudents);
        const imageUrl = r.cloudinary_image_url || r.omrImageUrl || null;

        try {
            await postSignedToWhatsAppServer('/send', {
                to: phone,
                message: messageText,
                imageUrl: imageUrl
            });

            job.sent++;
            job.logs.push(`✓ Sent to Parent of ${name} (${phone.slice(-4).padStart(phone.length, '•')}) — Rank #${rank}`);
        } catch (dispatchErr) {
            job.failed++;
            job.logs.push(`✗ Failed for Parent of ${name} (${phone.slice(-4).padStart(phone.length, '•')}): ${dispatchErr.message}`);
        }

        // Anti-ban humanized delay: wait 4 to 8 seconds between messages
        if (i < results.length - 1 && job.status === 'running') {
            const delayMs = 4000 + Math.floor(Math.random() * 4000); // 4000ms - 8000ms
            job.currentStudent.delaySeconds = Math.round(delayMs / 1000);
            await new Promise(res => setTimeout(res, delayMs));
        }
    }

    if (job.status === 'running') {
        job.status = 'completed';
    }
    job.completedTime = Date.now();
    job.currentStudent = null;
    job.logs.push(`🏁 Dispatch finished. Sent: ${job.sent}, Skipped: ${job.skipped}, Failed: ${job.failed} out of ${job.total}.`);
}

function getJobStatus(jobId) {
    return dispatchJobs.get(jobId) || null;
}

function cancelJob(jobId) {
    const job = dispatchJobs.get(jobId);
    if (!job) return false;
    if (job.status === 'running') {
        job.status = 'cancelled';
        return true;
    }
    return false;
}

module.exports = {
    startWhatsAppDispatchJob,
    getJobStatus,
    cancelJob,
    postSignedToWhatsAppServer,
    formatStudentWhatsAppMessage
};
