/**
 * =========================================================================
 * GARUD OMR - MULTI-PAPER ORDINARY CHECKER GOOGLE APPS SCRIPT BACKEND
 * =========================================================================
 * 
 * Each paper created gets its own dedicated:
 *  1. Answer Key Sheet:   "Key - <Paper Title>"
 *  2. Results Sheet:      "Results - <Paper Title>"
 *  3. Master Index Sheet: "Papers_Index" (tracks all created papers)
 * 
 * Setup Instructions:
 * 1. Open your Google Spreadsheet (https://sheets.google.com).
 * 2. In Google Sheets menu, click: Extensions > Apps Script.
 * 3. Replace any default code with this entire file.
 * 4. Click "Deploy" (top right) > "Manage deployments" (or "New deployment").
 * 5. If editing existing deployment: click Edit (pencil icon), select Version: "New version", click Deploy.
 *    - Execute as: "Me"
 *    - Who has access: "Anyone"
 * 6. The Web App URL is saved in your .env file as `deployment_url`.
 */

function sanitizeSheetName(name) {
  if (!name) return "Assessment";
  // Remove characters forbidden in Google Sheet tab names: \ / ? * [ ] :
  var clean = String(name).replace(/[\\/?*\[\]:]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length > 80) clean = clean.substring(0, 80).trim();
  return clean || "Assessment";
}

function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var param = (e && e.parameter) ? e.parameter : {};
    
    // 1. List all papers
    if (param.action === 'listPapers') {
      var sheets = ss.getSheets();
      var papersFound = [];
      for (var i = 0; i < sheets.length; i++) {
        var sName = sheets[i].getName();
        if (sName.indexOf("Key - ") === 0) {
          var pTitle = sName.substring(6).trim();
          papersFound.push({
            title: pTitle,
            keySheet: sName,
            resultsSheet: "Results - " + pTitle
          });
        }
      }
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        papers: papersFound
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    // 2. Fetch specific paper by title
    var requestedTitle = param.paperTitle || param.title || "";
    var targetSheetName = "";
    if (requestedTitle) {
      targetSheetName = sanitizeSheetName("Key - " + requestedTitle);
    }
    
    var keySheet = null;
    if (targetSheetName) {
      keySheet = ss.getSheetByName(targetSheetName);
    }
    
    // Fallbacks: find first sheet starting with "Key - " or "AnswerKey"
    if (!keySheet) {
      var allSheets = ss.getSheets();
      for (var s = 0; s < allSheets.length; s++) {
        var name = allSheets[s].getName();
        if (name.indexOf("Key - ") === 0 || name === "AnswerKey" || name === "Key") {
          keySheet = allSheets[s];
          break;
        }
      }
      if (!keySheet) keySheet = allSheets[0];
    }
    
    var data = keySheet.getDataRange().getValues();
    var answerKey = {};
    var sections = [];
    var sectionMap = {};
    
    var startRow = 1;
    if (data.length > 0 && typeof data[0][0] === 'string' && isNaN(parseInt(data[0][0]))) {
      startRow = 1; // Row 0 is header
    } else {
      startRow = 0;
    }
    
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
    
    var paperTitle = keySheet.getName().replace(/^Key\s*-\s*/, "");
    
    var response = {
      success: true,
      title: paperTitle || ss.getName(),
      totalQuestions: Object.keys(answerKey).length,
      answerKey: answerKey,
      sections: sections,
      keySheet: keySheet.getName(),
      resultsSheet: sanitizeSheetName("Results - " + paperTitle)
    };
    
    return ContentService.createTextOutput(JSON.stringify(response))
      .setMimeType(ContentService.MimeType.JSON);
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

    // -------------------------------------------------------------
    // ACTION 1: CREATE OR UPDATE PAPER (Dedicated Key & Results sheets)
    // -------------------------------------------------------------
    if (payload.action === 'savePaper' || payload.action === 'createPaper') {
      var paperTitle = String(payload.title || "Ordinary Assessment").trim();
      var paperId = String(payload.paperId || payload.id || "").trim();
      var totalQ = Number(payload.totalQuestions) || 180;
      var aKey = payload.answerKey || {};
      var secDefs = payload.sections || [];
      var subject = String(payload.subject || "General").trim();
      
      var keySheetName = sanitizeSheetName("Key - " + paperTitle);
      var resultsSheetName = sanitizeSheetName("Results - " + paperTitle);
      
      // 1. Create or update Answer Key Sheet for this paper
      var keySheet = ss.getSheetByName(keySheetName);
      if (!keySheet) {
        keySheet = ss.insertSheet(keySheetName);
      }
      keySheet.clear();
      keySheet.appendRow(["Question", "Answer", "Section"]);
      keySheet.getRange(1, 1, 1, 3)
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
        keySheet.getRange(2, 1, rows.length, 3).setValues(rows);
      }
      keySheet.setFrozenRows(1);

      // 2. Create or initialize Results Sheet for this paper
      var resultsSheet = ss.getSheetByName(resultsSheetName);
      if (!resultsSheet) {
        resultsSheet = ss.insertSheet(resultsSheetName);
      }
      if (resultsSheet.getLastRow() === 0) {
        var headers = ["Timestamp", "Student Name", "Roll Number"];
        secDefs.forEach(function(sd) { headers.push(sd.name); });
        headers.push("Total Marks");
        headers.push("Max Marks");
        resultsSheet.appendRow(headers);
        resultsSheet.getRange(1, 1, 1, headers.length)
          .setFontWeight("bold")
          .setBackground("#1E293B")
          .setFontColor("#FFFFFF");
        resultsSheet.setFrozenRows(1);
      }

      // 3. Maintain Master Papers Index tab
      var indexSheet = ss.getSheetByName("Papers_Index");
      if (!indexSheet) {
        indexSheet = ss.insertSheet("Papers_Index");
        indexSheet.appendRow(["Paper ID", "Title", "Subject", "Total Questions", "Key Sheet", "Results Sheet", "Last Updated"]);
        indexSheet.getRange(1, 1, 1, 7).setFontWeight("bold").setBackground("#0F172A").setFontColor("#FFFFFF");
        indexSheet.setFrozenRows(1);
      }
      
      // Check if paper already exists in index
      var indexData = indexSheet.getDataRange().getValues();
      var foundRow = -1;
      for (var idx = 1; idx < indexData.length; idx++) {
        if (indexData[idx][1] === paperTitle || (paperId && indexData[idx][0] === paperId)) {
          foundRow = idx + 1;
          break;
        }
      }
      
      var indexRowVals = [
        paperId || ("paper_" + Date.now()),
        paperTitle,
        subject,
        totalQ,
        keySheetName,
        resultsSheetName,
        new Date().toLocaleString()
      ];
      
      if (foundRow > 0) {
        indexSheet.getRange(foundRow, 1, 1, 7).setValues([indexRowVals]);
      } else {
        indexSheet.appendRow(indexRowVals);
      }

      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        message: "Paper '" + paperTitle + "' ready in Google Sheets! Created tabs: '" + keySheetName + "' & '" + resultsSheetName + "'.",
        keySheet: keySheetName,
        resultsSheet: resultsSheetName
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // -------------------------------------------------------------
    // ACTION 2: RECORD EVALUATED STUDENT RESULT FOR SPECIFIC PAPER
    // -------------------------------------------------------------
    var paperTitle = String(payload.paperTitle || "").trim();
    var resultsSheetName = paperTitle ? sanitizeSheetName("Results - " + paperTitle) : "Results";
    
    var resultsSheet = ss.getSheetByName(resultsSheetName);
    
    // Fallback if paper-specific sheet not found yet
    if (!resultsSheet) {
      if (paperTitle) {
        resultsSheet = ss.insertSheet(resultsSheetName);
      } else {
        resultsSheet = ss.getSheetByName("Results") || ss.insertSheet("Results");
      }
    }
    
    var studentName = String(payload.studentName || "Anonymous Student").trim();
    var rollNumber = String(payload.rollNumber || "-").trim();
    var totalMarks = payload.totalMarks !== undefined ? Number(payload.totalMarks) : Number(payload.score || 0);
    var maxMarks = payload.maxMarks !== undefined ? Number(payload.maxMarks) : 720;
    var sectionMarks = payload.sectionMarks || {};
    var sectionNames = Object.keys(sectionMarks);
    
    // If the results sheet has no headers, initialize them
    if (resultsSheet.getLastRow() === 0) {
      var headers = ["Timestamp", "Student Name", "Roll Number"];
      if (sectionNames.length > 0) {
        headers = headers.concat(sectionNames);
      } else {
        headers.push("Section Marks");
      }
      headers.push("Total Marks");
      headers.push("Max Marks");
      
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
    
    if (existingHeaders.length > 5) {
      for (var col = 3; col < existingHeaders.length - 2; col++) {
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
