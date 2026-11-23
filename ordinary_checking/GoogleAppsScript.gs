/**
 * =========================================================================
 * GARUD OMR - ORDINARY CHECKER GOOGLE APPS SCRIPT BACKEND
 * =========================================================================
 * 
 * Instructions:
 * 1. Open your Google Spreadsheet (https://sheets.google.com).
 * 2. Create a tab named "AnswerKey":
 *    - Row 1 Headers: Question | Answer | Section
 *    - Rows 2..N:     1        | A      | Physics
 *                     2        | B      | Physics
 *                     ...
 * 3. In Google Sheets menu, click: Extensions > Apps Script.
 * 4. Replace any default code with this entire file.
 * 5. Click "Deploy" (top right) > "New deployment".
 * 6. Select type: "Web app" (click the gear icon).
 *    - Description: Ordinary OMR Checker
 *    - Execute as: "Me"
 *    - Who has access: "Anyone"
 * 7. Click "Deploy" (Authorize if prompted).
 * 8. Copy the Web App URL (e.g. https://script.google.com/macros/s/.../exec)
 *    and paste it into your Ordinary Checker portal!
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
    var resultsSheet = ss.getSheetByName("Results");
    
    var payload = {};
    if (e && e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    }
    
    var studentName = String(payload.studentName || "Anonymous Student").trim();
    var rollNumber = String(payload.rollNumber || "-").trim();
    var totalMarks = payload.totalMarks !== undefined ? Number(payload.totalMarks) : Number(payload.score || 0);
    var maxMarks = payload.maxMarks !== undefined ? Number(payload.maxMarks) : 720;
    var sectionMarks = payload.sectionMarks || {}; // { "Physics": 160, "Chemistry": 150, ... }
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
    
    // Ensure existing header row has section columns if they were updated
    var existingHeaders = resultsSheet.getRange(1, 1, 1, Math.max(1, resultsSheet.getLastColumn())).getValues()[0] || [];
    var rowData = [
      new Date().toLocaleString(),
      studentName,
      rollNumber
    ];
    
    if (existingHeaders.length > 5) {
      // Columns align with existing headers
      for (var col = 3; col < existingHeaders.length - 2; col++) {
        var secHeader = String(existingHeaders[col]).trim();
        rowData.push(sectionMarks[secHeader] !== undefined ? sectionMarks[secHeader] : 0);
      }
    } else {
      // Append section values
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
