const { readSheet } = require('read-excel-file/node');

/**
 * Extract first 3 letters (lowercased) from a person's name.
 * Strips spaces/punctuation so initialed names (e.g. "A. R. Sharma") still yield 3 letters.
 * Falls back to alphanumeric characters if a name has no alphabetic letters.
 */
function extractFirst3(rawName) {
    const str = String(rawName == null ? '' : rawName).trim();
    if (!str) return '';
    const lettersOnly = str.replace(/[^a-zA-Z]/g, '').toLowerCase();
    if (lettersOnly.length > 0) {
        return lettersOnly.slice(0, 3);
    }
    return str.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 3);
}

/**
 * Compute initial student password:
 * first 3 letters of Name + first 3 letters of Father's Name + first 3 letters of Mother's Name (lowercase).
 */
function generateStudentPassword(name, fatherName, motherName) {
    return extractFirst3(name) + extractFirst3(fatherName) + extractFirst3(motherName);
}

/**
 * Normalize a column header token for resilient header matching.
 */
function normalizeHeader(cell) {
    return String(cell == null ? '' : cell)
        .trim()
        .toLowerCase()
        .replace(/['’`]/g, '')
        .replace(/[^a-z0-9]/g, '');
}

const HEADER_ALIASES = {
    rollnumber: new Set([
        'rollnumber', 'rollno', 'roll', 'rollnum', 'studentid', 'id',
        'regno', 'registrationno', 'registrationnumber', 'enrollmentno', 'enrollmentnumber'
    ]),
    name: new Set([
        'name', 'studentname', 'fullname', 'candidatename', 'student'
    ]),
    fatherName: new Set([
        'fathername', 'fathersname', 'father', 'fathers', 'fname', 'guardianname'
    ]),
    motherName: new Set([
        'mothername', 'mothersname', 'mother', 'mothers', 'mname'
    ])
};

/**
 * Parse CSV, TSV, or semicolon-delimited text into a 2D array of strings.
 */
function parseDelimitedText(rawText) {
    const clean = String(rawText || '').replace(/^\uFEFF/, '');
    const nonEmptyLines = clean.split(/\r\n|\n|\r/).filter(l => l.trim() !== '');
    if (nonEmptyLines.length === 0) return [];

    // Auto-detect delimiter from header / first line
    const sample = nonEmptyLines[0];
    const tabCount = (sample.match(/\t/g) || []).length;
    const semiCount = (sample.match(/;/g) || []).length;
    const commaCount = (sample.match(/,/g) || []).length;

    let delim = ',';
    if (tabCount > commaCount && tabCount >= semiCount) delim = '\t';
    else if (semiCount > commaCount && semiCount > tabCount) delim = ';';

    const rows = [];
    let currentRow = [];
    let currentCell = '';
    let inQuotes = false;

    for (let i = 0; i < clean.length; i++) {
        const ch = clean[i];
        const next = clean[i + 1];

        if (ch === '"') {
            if (inQuotes && next === '"') {
                currentCell += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === delim && !inQuotes) {
            currentRow.push(currentCell.trim());
            currentCell = '';
        } else if ((ch === '\r' || ch === '\n') && !inQuotes) {
            if (ch === '\r' && next === '\n') i++;
            currentRow.push(currentCell.trim());
            if (currentRow.some(c => c !== '')) {
                rows.push(currentRow);
            }
            currentRow = [];
            currentCell = '';
        } else {
            currentCell += ch;
        }
    }

    currentRow.push(currentCell.trim());
    if (currentRow.some(c => c !== '')) {
        rows.push(currentRow);
    }

    return rows;
}

/**
 * Detect column indices from row 0 (header-driven or positional fallback when pasted without headers).
 */
function detectColumns(firstRow) {
    const indices = {
        rollnumber: -1,
        name: -1,
        fatherName: -1,
        motherName: -1
    };
    let matchedCount = 0;

    firstRow.forEach((cell, idx) => {
        const token = normalizeHeader(cell);
        if (!token) return;
        for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
            if (indices[key] === -1 && aliases.has(token)) {
                indices[key] = idx;
                matchedCount++;
                break;
            }
        }
    });

    if (matchedCount >= 2) {
        const missing = [];
        if (indices.rollnumber === -1) missing.push('Roll Number');
        if (indices.name === -1) missing.push('Name');
        if (indices.fatherName === -1) missing.push("Father's Name");
        if (indices.motherName === -1) missing.push("Mother's Name");

        if (missing.length > 0) {
            throw new Error(`Missing required column(s): ${missing.join(', ')}. Expected: Roll Number, Name, Father's Name, Mother's Name.`);
        }
        return { hasHeader: true, indices };
    }

    // Check if firstRow looks headerless (4+ cells without header words)
    const rowTokens = firstRow.map(normalizeHeader).join(' ');
    const looksLikeHeader = /\b(roll|name|father|mother)\b/.test(rowTokens);
    if (!looksLikeHeader && firstRow.length >= 4) {
        return {
            hasHeader: false,
            indices: { rollnumber: 0, name: 1, fatherName: 2, motherName: 3 }
        };
    }

    throw new Error("Could not detect required columns. Include headers: Roll Number, Name, Father's Name, Mother's Name.");
}

/**
 * Normalize raw 2D grid into validated student candidate objects.
 * Note: fatherName & motherName are used only in-memory for password preview/creation
 * and are NOT stored in MongoDB.
 */
function buildStudentRowsFromGrid(grid) {
    if (!Array.isArray(grid) || grid.length === 0) {
        throw new Error('No rows found in uploaded data.');
    }

    const { hasHeader, indices } = detectColumns(grid[0]);
    const startIdx = hasHeader ? 1 : 0;
    const seenUsernames = new Set();
    const parsedRows = [];

    for (let r = startIdx; r < grid.length; r++) {
        const row = grid[r] || [];
        const rawRoll = row[indices.rollnumber];
        const rawName = row[indices.name];
        const rawFather = row[indices.fatherName];
        const rawMother = row[indices.motherName];

        const rollnumber = String(rawRoll == null ? '' : rawRoll).trim();
        const name = String(rawName == null ? '' : rawName).trim();
        const fatherName = String(rawFather == null ? '' : rawFather).trim();
        const motherName = String(rawMother == null ? '' : rawMother).trim();

        if (!rollnumber && !name && !fatherName && !motherName) continue;

        const rowNumber = r + 1;
        const username = rollnumber.toLowerCase().replace(/\s+/g, '');
        const generatedPassword = generateStudentPassword(name, fatherName, motherName);

        let status = 'ready';
        let reason = '';

        if (!rollnumber) {
            status = 'invalid';
            reason = 'Roll number is required';
        } else if (!/^[a-z0-9._-]{2,40}$/.test(username)) {
            status = 'invalid';
            reason = 'Roll number must be 2-40 characters (letters, digits, ., _, -)';
        } else if (!name || extractFirst3(name).length === 0) {
            status = 'invalid';
            reason = 'Student name must contain letters';
        } else if (!fatherName || extractFirst3(fatherName).length === 0) {
            status = 'invalid';
            reason = "Father's name must contain letters";
        } else if (!motherName || extractFirst3(motherName).length === 0) {
            status = 'invalid';
            reason = "Mother's name must contain letters";
        } else if (seenUsernames.has(username)) {
            status = 'duplicate_in_file';
            reason = 'Duplicate roll number in upload';
        } else {
            seenUsernames.add(username);
        }

        parsedRows.push({
            rowNumber,
            rollnumber,
            username,
            name,
            fatherName,
            motherName,
            generatedPassword,
            status,
            reason
        });
    }

    if (parsedRows.length === 0) {
        throw new Error('No student data rows found below header.');
    }

    return parsedRows;
}

/**
 * Read uploaded spreadsheet buffer (.xlsx / .csv / .tsv / .txt) or pasted text into parsed rows.
 */
async function parseBulkStudentsInput({ file = null, rawText = '' }) {
    let grid = [];

    if (file && file.buffer) {
        const ext = String(file.originalname || '').toLowerCase().split('.').pop();
        if (ext === 'xls') {
            throw new Error('Legacy .xls binary files are not supported. Please save your spreadsheet as .xlsx or .csv.');
        }
        if (ext === 'xlsx') {
            grid = await readSheet(file.buffer);
        } else if (ext === 'csv' || ext === 'tsv' || ext === 'txt' || !ext) {
            grid = parseDelimitedText(file.buffer.toString('utf8'));
        } else {
            throw new Error(`Unsupported file format ".${ext}". Upload a .xlsx or .csv file.`);
        }
    } else if (rawText && String(rawText).trim() !== '') {
        grid = parseDelimitedText(rawText);
    } else {
        throw new Error('Upload a .xlsx/.csv file or paste student rows.');
    }

    return buildStudentRowsFromGrid(grid);
}

/**
 * Filter parsed rows against existing users in MongoDB.
 */
async function annotateExistingUsers(rows, UserModel) {
    const validCandidates = rows.filter(r => r.status === 'ready');
    if (validCandidates.length === 0) return rows;

    const usernames = [...new Set(validCandidates.map(r => r.username))];
    const rollVariants = [...new Set(
        validCandidates.flatMap(r => [r.rollnumber, r.rollnumber.toUpperCase(), r.rollnumber.toLowerCase()])
    )];

    const existing = await UserModel.find({
        $or: [
            { username: { $in: usernames } },
            { role: 'student', rollnumber: { $in: rollVariants } }
        ]
    }, 'username rollnumber').lean();

    const existingUsernames = new Set(existing.map(u => String(u.username || '').toLowerCase()));
    const existingRolls = new Set(existing.map(u => String(u.rollnumber || '').trim().toLowerCase()).filter(Boolean));

    return rows.map(r => {
        if (r.status !== 'ready') return r;
        if (existingUsernames.has(r.username) || existingRolls.has(r.rollnumber.toLowerCase())) {
            return {
                ...r,
                status: 'exists',
                reason: 'Account already exists (skipped)'
            };
        }
        return r;
    });
}

module.exports = {
    extractFirst3,
    generateStudentPassword,
    parseDelimitedText,
    parseBulkStudentsInput,
    buildStudentRowsFromGrid,
    annotateExistingUsers
};

