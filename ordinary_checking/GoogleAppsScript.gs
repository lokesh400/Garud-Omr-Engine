/**
 * =========================================================================
 * GARUD OMR - MULTI-PAPER GOOGLE APPS SCRIPT (CLOUD-ONLY STORAGE)
 * =========================================================================
 * 
 * Rules:
 *  1. Every paper gets its own NEW sheet tab for questions & answer keys:
 *     "Paper - <Title>" (e.g., "Paper - NEET Mock 01")
 *  2. Every paper gets its own NEW sheet tab for results:
 *     "Results - <Title>" (e.g., "Results - NEET Mock 01")
 *  3. Old papers and their results sheets are NEVER overwritten or deleted.
 *  4. No papers are stored on the local computer - Google Sheets is the single database.
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
          
          if (!isNaN(qNum) && qNum > 0) {
            answerKey[String(qNum)] = ans;
            if (!sectionMap[secName]) {
              sectionMap[secName] = { name: secName, from: qNum, to: qNum };
              sections.push(sectionMap[secName]);
            } else {
              sectionMap[secName].to = Math.max(sectionMap[secName].to, qNum);
            }
          }
        }
        
        var totalQ = Object.keys(answerKey).length;
        if (totalQ === 0) totalQ = 180;
        
        if (!maxMarks || maxMarks === 720) {
          maxMarks = totalQ * 4;
        }
        
        sections.forEach(function(sec) {
          sec.maxMarks = (sec.to - sec.from + 1) * 4;
        });
        
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
      keySheet.appendRow(["Question", "Answer Key", "Section"]);
      keySheet.getRange(2, 1, 1, 3)
        .setFontWeight("bold")
        .setBackground("#1E293B")
        .setFontColor("#FFFFFF");
      
      function getSectionName(q) {
        for (var s = 0; s < secDefs.length; s++) {
          if (q >= secDefs[s].from && q <= secDefs[s].to) {
            return secDefs[s].name;
          }
        }
        return "Section 1";
      }
      
      var rows = [];
      for (var q = 1; q <= totalQ; q++) {
        var ans = String(aKey[String(q)] || "").trim().toUpperCase();
        rows.push([q, ans, getSectionName(q)]);
      }
      
      if (rows.length > 0) {
        keySheet.getRange(3, 1, rows.length, 3).setValues(rows);
      }
      keySheet.setFrozenRows(2);
      
      // 2. Create the Results sheet for this paper (if not already existing)
      var resultsSheet = ss.getSheetByName(resultsSheetName);
      if (!resultsSheet) {
        resultsSheet = ss.insertSheet(resultsSheetName);
      }
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
    // ACTION 2: RECORD EVALUATED STUDENT RESULT
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
    
    if (resultsSheet.getLastRow() === 0) {
      var headers = ["Timestamp", "Student Name", "Roll Number"];
      if (sectionNames.length > 0) {
        headers = headers.concat(sectionNames);
      } else {
        headers.push("Section Marks");
      }
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
    
    var existingHeaders = resultsSheet.getRange(1, 1, 1, Math.max(1, resultsSheet.getLastColumn())).getValues()[0] || [];
    var rowData = [
      new Date().toLocaleString(),
      studentName,
      rollNumber
    ];
    
    // Match section marks with column headers
    if (existingHeaders.length > 5) {
      for (var col = 3; col < existingHeaders.length - 3; col++) {
        var secHeader = String(existingHeaders[col]).trim();
        rowData.push(sectionMarks[secHeader] !== undefined ? sectionMarks[secHeader] : 0);
      }
    } else {
      sectionNames.forEach(function(s) {
        rowData.push(sectionMarks[s]);
      });
    }
    
    rowData.push(totalMarks);
    rowData.push(maxMarks);
    
    var pct = maxMarks > 0 ? (Math.round((totalMarks / maxMarks) * 1000) / 10) + "%" : "0%";
    rowData.push(pct);
    
    resultsSheet.appendRow(rowData);
    
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      message: "Result recorded successfully for " + studentName + " in sheet '" + resultsSheet.getName() + "'",
      studentName: studentName,
      sheetName: resultsSheet.getName(),
      totalMarks: totalMarks
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: err.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}
