/**
 * =========================================================================
 * GARUD OMR - ORDINARY CHECKER GOOGLE APPS SCRIPT BACKEND
 * =========================================================================
 * 
 * Instructions:
 * 1. Open your Google Spreadsheet (https://sheets.google.com).
 * 2. In Google Sheets menu, click: Extensions > Apps Script.
 * 3. Replace any default code with this entire file.
 * 4. Click "Deploy" (top right) > "Manage deployments" (or "New deployment").
 * 5. If editing existing deployment: click Edit (pencil icon), select Version: "New version", click Deploy.
 *    - Execute as: "Me"
 *    - Who has access: "Anyone"
 * 6. The deployment URL is saved in your .env as `deployment_url`.
 */

function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // Look for AnswerKey tab, or fallback to first sheet
    var keySheet = ss.getSheetByName("AnswerKey") || ss.getSheetByName("Key") || ss.getSheets()[0];
    var data = keySheet.getDataRange().getValues();
    
    var answerKey = {};
    var sections = [];
    var sectionMap = {};
    
    // Find header row or assume row 1
    var startRow = 1;
    if (data.length > 0 && typeof data[0][0] === 'string' && isNaN(parseInt(data[0][0]))) {
      startRow = 1; // Row 0 is header
    } else {
      startRow = 0; // Data starts immediately
    }
    
    for (var i = startRow; i < data.length; i++) {
      var row = data[i];
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
    
    var response = {
      success: true,
      title: ss.getName(),
      totalQuestions: Object.keys(answerKey).length,
      answerKey: answerKey,
      sections: sections
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
    // ACTION 1: CREATE / SAVE PAPER ANSWER KEY & SECTIONS TO SHEET
    // -------------------------------------------------------------
    if (payload.action === 'savePaper' || payload.action === 'createPaper') {
      var keySheet = ss.getSheetByName("AnswerKey");
      if (!keySheet) {
        keySheet = ss.insertSheet("AnswerKey");
      }
      keySheet.clear();
      keySheet.appendRow(["Question", "Answer", "Section"]);
      keySheet.getRange(1, 1, 1, 3).setFontWeight("bold").setBackground("#1E293B").setFontColor("#FFFFFF");
      
      var totalQ = Number(payload.totalQuestions) || 180;
      var aKey = payload.answerKey || {};
      var secDefs = payload.sections || [];
      
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

      // Prepare Results Sheet headers aligned with sections
      var resultsSheet = ss.getSheetByName("Results");
      if (!resultsSheet) {
        resultsSheet = ss.insertSheet("Results");
      }
      if (resultsSheet.getLastRow() <= 1 && secDefs.length > 0) {
        resultsSheet.clear();
        var headers = ["Timestamp", "Student Name", "Roll Number"];
        secDefs.forEach(function(sd) { headers.push(sd.name); });
        headers.push("Total Marks");
        headers.push("Max Marks");
        resultsSheet.appendRow(headers);
        resultsSheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#1E293B").setFontColor("#FFFFFF");
        resultsSheet.setFrozenRows(1);
      }

      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        message: "Paper '" + (payload.title || "Assessment") + "' saved to Google Sheet with " + totalQ + " questions."
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // -------------------------------------------------------------
    // ACTION 2: RECORD EVALUATED STUDENT RESULT
    // -------------------------------------------------------------
    var resultsSheet = ss.getSheetByName("Results");
    var studentName = String(payload.studentName || "Anonymous Student").trim();
    var rollNumber = String(payload.rollNumber || "-").trim();
    var totalMarks = payload.totalMarks !== undefined ? Number(payload.totalMarks) : Number(payload.score || 0);
    var maxMarks = payload.maxMarks !== undefined ? Number(payload.maxMarks) : 720;
    var sectionMarks = payload.sectionMarks || {};
    var sectionNames = Object.keys(sectionMarks);
    
    // Create Results sheet if it doesn't exist
    if (!resultsSheet) {
      resultsSheet = ss.insertSheet("Results");
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
      message: "Result recorded successfully for " + studentName,
      studentName: studentName,
      totalMarks: totalMarks
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: err.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}
