/**
 * =========================================================================
 * GARUD OMR - MULTI-PAPER GOOGLE APPS SCRIPT (SECTION-WISE MARKS READY)
 * =========================================================================
 * 
 * Rules:
 *  1. Every paper gets its own dedicated sheet tab for questions, keys & marking scheme:
 *     "Paper - <Title>" (e.g., "Paper - NEET Mock 01")
 *  2. Every paper gets its own dedicated Results sheet tab with separate section columns:
 *     "Results - <Title>" (e.g., "Results - NEET Mock 01")
 *     Columns: Timestamp | Student Name | Roll Number | <Section 1> | <Section 2> | ... | Total Marks | Max Marks | Percentage
 *  3. Old papers and their results sheets are NEVER overwritten or deleted.
 *  4. Section marks are placed dynamically into their exact matching section columns.
 * 
 * Instructions to Update in Google Sheets:
 *  1. Open your Google Spreadsheet (https://sheets.google.com).
 *  2. Go to: Extensions > Apps Script.
 *  3. Replace ALL existing code with this entire file.
 *  4. Click "Deploy" > "Manage deployments".
 *  5. Click the Edit (pencil icon) button on the active deployment.
 *  6. Change Version to: "New version".
 *  7. Click "Deploy".
 */

function sanitizeSheetName(name) {
  if (!name) return "Assessment";
  // Remove characters forbidden in Google Sheet tab names: \ / ? * [ ] :
  var clean = String(name).replace(/[\\/?*\[\]:]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length > 70) clean = clean.substring(0, 70).trim();
  return clean || "Assessment";
}

function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var param = (e && e.parameter) ? e.parameter : {};
    var sheets = ss.getSheets();
    
    var papers = [];
    var seenTitles = {};
    
    // Scan all sheets in the spreadsheet for paper / key sheets
    for (var i = 0; i < sheets.length; i++) {
      var sheet = sheets[i];
      var sName = sheet.getName();
      
      var isPaperSheet = sName.indexOf("Paper - ") === 0;
      var isKeySheet = sName.indexOf("Key - ") === 0;
      var isLegacyKey = sName === "AnswerKey" || sName === "Key";
      
      if (isPaperSheet || isKeySheet || isLegacyKey) {
        var title = sName;
        if (isPaperSheet) title = sName.substring(8).trim();
        else if (isKeySheet) title = sName.substring(6).trim();
        
        if (seenTitles[title.toLowerCase()]) continue;
        seenTitles[title.toLowerCase()] = true;
        
        var data = sheet.getDataRange().getValues();
        var subject = "General";
        var maxMarks = 720;
        var startRow = 1;
        
        // Check if Row 1 has metadata (Subject, Max Marks)
        if (data.length > 0 && typeof data[0][0] === 'string' && data[0][0].indexOf('Subject:') === 0) {
          subject = data[0][0].replace('Subject:', '').trim();
          if (data[0][1] && String(data[0][1]).indexOf('MaxMarks:') === 0) {
            maxMarks = Number(String(data[0][1]).replace('MaxMarks:', '').trim()) || 720;
          }
          startRow = 2; // Data starts on row 3 (index 2)
        } else if (data.length > 0 && typeof data[0][0] === 'string' && isNaN(parseInt(data[0][0]))) {
          startRow = 1; // Header row on row 1 (index 0)
        } else {
          startRow = 0;
        }
        
        var answerKey = {};
        var sections = [];
        var sectionMap = {};
        
        for (var r = startRow; r < data.length; r++) {
          var row = data[r];
          var qNum = parseInt(row[0]);
          var ans = String(row[1] || "").trim().toUpperCase();
          var secName = String(row[2] || "").trim() || "Section 1";
          var correctM = row[3] !== undefined ? Number(row[3]) : 4;
          var wrongM = row[4] !== undefined ? Number(row[4]) : 1;
          
          if (!isNaN(qNum) && qNum > 0) {
            answerKey[String(qNum)] = ans;
            if (!sectionMap[secName]) {
              sectionMap[secName] = {
                name: secName,
                from: qNum,
                to: qNum,
                correctMarks: correctM,
                negativeMarks: wrongM
              };
              sections.push(sectionMap[secName]);
            } else {
              sectionMap[secName].to = Math.max(sectionMap[secName].to, qNum);
            }
          }
        }
        
        var totalQ = Object.keys(answerKey).length;
        if (totalQ === 0) totalQ = 180;
        
        // Compute section max marks based on their correctMarks
        sections.forEach(function(sec) {
          var c = (sec.correctMarks !== undefined) ? Number(sec.correctMarks) : 4;
          sec.maxMarks = (sec.to - sec.from + 1) * c;
        });
        
        if (!maxMarks || maxMarks === 720) {
          var sumM = 0;
          sections.forEach(function(s) { sumM += s.maxMarks; });
          maxMarks = sumM > 0 ? sumM : (totalQ * 4);
        }
        
        papers.push({
          id: sanitizeSheetName(title),
          _id: sanitizeSheetName(title),
          title: title,
          subject: subject,
          totalQuestions: totalQ,
          maxMarks: maxMarks,
          sections: sections,
          answerKey: answerKey,
          keySheet: sName,
          resultsSheet: sanitizeSheetName("Results - " + title)
        });
      }
    }
    
    // If specific paper requested
    var reqTitle = param.paperTitle || param.title;
    if (reqTitle) {
      for (var p = 0; p < papers.length; p++) {
        if (papers[p].title.toLowerCase() === reqTitle.toLowerCase() || papers[p].id === reqTitle) {
          return ContentService.createTextOutput(JSON.stringify({ success: true, ...papers[p] }))
            .setMimeType(ContentService.MimeType.JSON);
        }
      }
    }
    
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      title: ss.getName(),
      papers: papers,
      totalQuestions: papers.length > 0 ? papers[0].totalQuestions : 0,
      answerKey: papers.length > 0 ? papers[0].answerKey : {},
      sections: papers.length > 0 ? papers[0].sections : []
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    
    var payload = {};
    if (e && e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    }

    // =============================================================
    // ACTION 1: CREATE OR UPDATE A PAPER (NEVER OVERWRITES OTHER PAPERS)
    // =============================================================
    if (payload.action === 'savePaper' || payload.action === 'createPaper') {
      var paperTitle = String(payload.title || "Ordinary Assessment").trim();
      var subject = String(payload.subject || "General").trim();
      var totalQ = Number(payload.totalQuestions) || 180;
      var maxMarks = Number(payload.maxMarks) || (totalQ * 4);
      var aKey = payload.answerKey || {};
      var secDefs = payload.sections || [];
      
      var keySheetName = sanitizeSheetName("Paper - " + paperTitle);
      var resultsSheetName = sanitizeSheetName("Results - " + paperTitle);
      
      // 1. Create or update the Paper & Key sheet
      var keySheet = ss.getSheetByName(keySheetName);
      if (!keySheet) {
        keySheet = ss.insertSheet(keySheetName);
      } else {
        keySheet.clear();
      }
      
      // Metadata Row
      keySheet.appendRow(["Subject: " + subject, "MaxMarks: " + maxMarks, "Title: " + paperTitle]);
      keySheet.getRange(1, 1, 1, 3).setFontColor("#64748B").setFontSize(9);
      
      // Headers Row
      keySheet.appendRow(["Question", "Answer Key", "Section", "Correct (+)", "Wrong (-)"]);
      keySheet.getRange(2, 1, 1, 5)
        .setFontWeight("bold")
        .setBackground("#1E293B")
        .setFontColor("#FFFFFF");
      
      function getSectionInfo(q) {
        for (var s = 0; s < secDefs.length; s++) {
          if (q >= secDefs[s].from && q <= secDefs[s].to) {
            return {
              name: secDefs[s].name,
              correct: (secDefs[s].correctMarks !== undefined) ? Number(secDefs[s].correctMarks) : 4,
              wrong: (secDefs[s].negativeMarks !== undefined) ? Number(secDefs[s].negativeMarks) : 1
            };
          }
        }
        return { name: "Section 1", correct: 4, wrong: 1 };
      }
      
      var rows = [];
      for (var q = 1; q <= totalQ; q++) {
        var ans = String(aKey[String(q)] || "").trim().toUpperCase();
        var sInfo = getSectionInfo(q);
        rows.push([q, ans, sInfo.name, sInfo.correct, sInfo.wrong]);
      }
      
      if (rows.length > 0) {
        keySheet.getRange(3, 1, rows.length, 5).setValues(rows);
      }
      keySheet.setFrozenRows(2);
      
      // 2. Create or initialize the Results sheet for this paper with dedicated section columns
      var resultsSheet = ss.getSheetByName(resultsSheetName);
      if (!resultsSheet) {
        resultsSheet = ss.insertSheet(resultsSheetName);
      }
      
      // Always ensure headers match section definitions
      if (resultsSheet.getLastRow() === 0) {
        var headers = ["Timestamp", "Student Name", "Roll Number"];
        secDefs.forEach(function(sd) { headers.push(sd.name); });
        headers.push("Total Marks");
        headers.push("Max Marks");
        headers.push("Percentage");
        
        resultsSheet.appendRow(headers);
        resultsSheet.getRange(1, 1, 1, headers.length)
          .setFontWeight("bold")
          .setBackground("#1E293B")
          .setFontColor("#FFFFFF");
        resultsSheet.setFrozenRows(1);
      }
      
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        message: "Paper '" + paperTitle + "' saved to Google Sheets! Tabs created: '" + keySheetName + "' and '" + resultsSheetName + "'.",
        keySheet: keySheetName,
        resultsSheet: resultsSheetName,
        title: paperTitle
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // =============================================================
    // ACTION 2: RECORD EVALUATED STUDENT RESULT WITH SECTION MARKS
    // =============================================================
    var paperTitle = String(payload.paperTitle || "").trim();
    var resultsSheetName = paperTitle ? sanitizeSheetName("Results - " + paperTitle) : "Results";
    
    var resultsSheet = ss.getSheetByName(resultsSheetName);
    if (!resultsSheet) {
      resultsSheet = ss.insertSheet(resultsSheetName);
    }
    
    var studentName = String(payload.studentName || "Anonymous Student").trim();
    var rollNumber = String(payload.rollNumber || "-").trim();
    var totalMarks = payload.totalMarks !== undefined ? Number(payload.totalMarks) : Number(payload.score || 0);
    var maxMarks = payload.maxMarks !== undefined ? Number(payload.maxMarks) : 720;
    var sectionMarks = payload.sectionMarks || {};
    var sectionNames = Object.keys(sectionMarks);
    
    // Check existing headers or initialize them
    var lastCol = Math.max(1, resultsSheet.getLastColumn());
    var existingHeaders = resultsSheet.getLastRow() > 0 
      ? (resultsSheet.getRange(1, 1, 1, lastCol).getValues()[0] || [])
      : [];
    
    // Check if section columns are present in existing headers
    var hasSectionCol = false;
    for (var c = 0; c < existingHeaders.length; c++) {
      var hClean = String(existingHeaders[c]).trim().toLowerCase();
      if (hClean && hClean !== "timestamp" && hClean !== "student name" && hClean !== "roll number" && hClean !== "total marks" && hClean !== "max marks" && hClean !== "percentage") {
        hasSectionCol = true;
        break;
      }
    }
    
    if (existingHeaders.length === 0 || (!hasSectionCol && sectionNames.length > 0)) {
      var newHeaders = ["Timestamp", "Student Name", "Roll Number"];
      sectionNames.forEach(function(s) { newHeaders.push(s); });
      newHeaders.push("Total Marks");
      newHeaders.push("Max Marks");
      newHeaders.push("Percentage");
      
      if (resultsSheet.getLastRow() === 0) {
        resultsSheet.appendRow(newHeaders);
      } else {
        resultsSheet.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
      }
      
      resultsSheet.getRange(1, 1, 1, newHeaders.length)
        .setFontWeight("bold")
        .setBackground("#1E293B")
        .setFontColor("#FFFFFF");
      resultsSheet.setFrozenRows(1);
      existingHeaders = newHeaders;
    }
    
    var rowData = [];
    var pct = maxMarks > 0 ? (Math.round((totalMarks / maxMarks) * 1000) / 10) + "%" : "0%";
    
    for (var col = 0; col < existingHeaders.length; col++) {
      var hName = String(existingHeaders[col]).trim();
      var hLower = hName.toLowerCase();
      
      if (hLower === "timestamp") {
        rowData.push(new Date().toLocaleString());
      } else if (hLower === "student name") {
        rowData.push(studentName);
      } else if (hLower === "roll number") {
        rowData.push(rollNumber);
      } else if (hLower === "total marks") {
        rowData.push(totalMarks);
      } else if (hLower === "max marks") {
        rowData.push(maxMarks);
      } else if (hLower === "percentage") {
        rowData.push(pct);
      } else {
        // Section column: lookup by exact or case-insensitive match
        var val = 0;
        if (sectionMarks[hName] !== undefined) {
          val = sectionMarks[hName];
        } else {
          for (var sKey in sectionMarks) {
            if (sKey.toLowerCase() === hLower) {
              val = sectionMarks[sKey];
              break;
            }
          }
        }
        rowData.push(Number(val));
      }
    }
    
    resultsSheet.appendRow(rowData);
    
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      message: "Result recorded successfully for " + studentName + " in sheet '" + resultsSheet.getName() + "'",
      studentName: studentName,
      sheetName: resultsSheet.getName(),
      totalMarks: totalMarks,
      sectionMarks: sectionMarks
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: err.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}
