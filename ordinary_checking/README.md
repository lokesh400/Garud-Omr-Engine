# Ordinary OMR Checker Workspace (Google Sheets Integration)

A lightweight, dedicated OMR checking workspace built for fast grading with **Google Sheets**.

---

## Key Characteristics
- **Zero Database Footprint**: Does **not** read or store papers, answer keys, or submissions in MongoDB.
- **Zero Cloud Storage**: Does **not** upload scanned sheet images to Cloudinary.
- **Google Sheets as Data Store**:
  - The **Paper and Answer Key** are loaded directly from a Google Sheet.
  - The **Evaluated Results** (Student Name, Roll Number, Section-wise Marks, Overall Total Marks) are appended directly into the Google Sheet.
- **No User Management Lookup**: While checking, the teacher simply enters the **Student Name** on the evaluation/scanner screen, and the result is recorded for that student immediately.
- **NEET Optical Precision**: Retains the identical optical scanning, corner alignment, perspective leveling, and bubble thresholding engine as the standard NEET OMR evaluator.

---

## Workspace Structure
```
ordinary_checking/
├── GoogleAppsScript.gs     # The Google Apps Script to paste into your Google Sheet
├── googleSheetService.js   # Service to fetch AnswerKey and append Results to Google Sheet
├── routes.js               # Express router for /ordinary routes
├── server.js               # Standalone server runner (run without MongoDB on port 3001)
├── views/
│   ├── index.ejs           # Main setup dashboard (connect sheet, view paper details)
│   ├── scanner.ejs         # Live Camera Scanner with student name input & Google Sheets save
│   └── evaluator.ejs       # File Upload / Drag & Drop Evaluator with student name input
└── README.md
```

---

## Setup Guide (2 Minutes)

### Step 1: Prepare your Google Sheet
1. Open [Google Sheets](https://sheets.google.com) and create a new spreadsheet.
2. In the first tab (rename it to `AnswerKey`), set up your key:
   - **Row 1 Headers**: `Question | Answer | Section`
   - **Rows 2..181**:
     - `1 | A | Physics`
     - `2 | B | Physics`
     - ...
     - `46 | C | Chemistry`
     - ...

### Step 2: Add Google Apps Script
1. In your Google Sheet, click **Extensions > Apps Script**.
2. Copy and paste the code from [`ordinary_checking/GoogleAppsScript.gs`](./GoogleAppsScript.gs).
3. Click **Deploy > New deployment**.
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy**, authorize if prompted, and copy the **Web App URL** (`https://script.google.com/macros/s/.../exec`).

### Step 3: Start Checking
1. Open your browser to `http://localhost:3000/ordinary` (or run standalone: `node ordinary_checking/server.js` at `http://localhost:3001/ordinary`).
2. Paste the Web App URL into the setup box and click **Save & Load Paper**.
3. Choose either **Launch Camera Scanner** or **Launch File Evaluator**.
4. Scan or upload an OMR sheet, type the **Student Name**, and click **Save to Google Sheet** (or hit `Enter`)!
5. The result row will immediately appear in your Google Sheet under the **Results** tab.
