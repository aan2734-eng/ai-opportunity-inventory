/**
 * AI Opportunity Inventory — Apps Script backend (v2)
 *
 * Replaces the v1 web app that served the custom GPT. Changes from v1:
 *  - The API secret lives in Script Properties (API_KEY), NOT in this file
 *    and NOT in any client-visible prompt. Rotate the old key: this
 *    deployment should use a NEW value that has never been shared in a doc.
 *  - Two new read actions: listOpportunities and checkRoster.
 *  - Every response is JSON: { ok: true, data } or { ok: false, error }.
 *
 * Setup (see HANDOFF.md in the site repo):
 *  1. Extensions → Apps Script on the workflow spreadsheet.
 *  2. Paste this file. Project Settings → Script Properties:
 *       API_KEY                = <new random secret, e.g. 64 hex chars>
 *       ROSTER_SPREADSHEET_ID  = <ID of the interest-form responses spreadsheet>
 *       ROSTER_SHEET_NAME      = <tab name, usually "Form Responses 1">
 *       OPPORTUNITIES_SPREADSHEET_ID = <ID of the public-view tracker sheet>
 *       OPPORTUNITIES_SHEET_NAME     = <tab name, usually "Sheet1">
 *       WORDPRESS_SITE_URL            = <WordPress site URL, without /wp-json/...>
 *       WORDPRESS_USERNAME            = <WordPress user with permission to create drafts>
 *       WORDPRESS_APP_PASSWORD        = <WordPress application password>
 *  3. Ensure the workflow spreadsheet has tabs: Prospects, Assignments, Reviews
 *     (they are created automatically on first write if missing).
 *  4. Deploy → New deployment → Web app → Execute as: Me →
 *     Who has access: Anyone. Copy the /exec URL into the site's
 *     APPS_SCRIPT_URL env var and the API_KEY value into APPS_SCRIPT_SECRET.
 */

var PROSPECT_HEADERS = [
  "prospectId", "createdAt", "studentName", "school", "email",
  "opportunityTitle", "oneSentenceClaim", "domain", "jurisdiction", "sourceLinks",
  "status", "closestExistingMatches", "triageDecision", "aiTriageConfidence",
  "assignedMemoType", "requestedChangeOrDirection", "notes",
];

var ASSIGNMENT_HEADERS = [
  "assignmentId", "createdAt", "prospectId", "studentName", "school",
  "assignedMemoType", "dueDate", "requiredFocusAreas", "requiredPrimaryLaw",
  "opportunityId", "notes", "status",
];

var REVIEW_HEADERS = [
  "reviewId", "createdAt", "prospectId", "opportunityTitle", "studentName", "school",
  "draftLink", "aiRubricScore", "aiSummaryForReviewer",
  "humanReviewStatus", "humanReviewer", "publicationDecision", "reviewerNotes",
];

function doPost(e) {
  var out;
  try {
    var body = JSON.parse(e.postData.contents);
    var props = PropertiesService.getScriptProperties();
    var apiKey = props.getProperty("API_KEY");
    if (!apiKey || body.secret !== apiKey) {
      out = { ok: false, error: "Unauthorized" };
    } else {
      out = { ok: true, data: route_(body) };
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function route_(body) {
  switch (body.action) {
    case "listOpportunities": return listOpportunities_();
    case "checkRoster": return checkRoster_(body);
    case "searchExistingOpportunities": return searchExistingOpportunities_(body);
    case "createProspect": return createProspect_(body);
    case "updateProspectStatus": return updateProspectStatus_(body);
    case "createAssignment": return createAssignment_(body);
    case "submitForHumanReview": return submitForHumanReview_(body);
    default: throw new Error("Unknown action: " + body.action);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Maps the public-view sheet's columns A–O to the JSON field names the site uses.
var OPPORTUNITY_FIELDS = [
  "website", "title", "summary", "submitter", "orgType", "govBranch",
  "orgLocation", "domain", "beneficiaries", "geoScope", "deploymentStage",
  "evidence", "aiModel", "barriers", "enablers",
];

function opportunitiesSheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("OPPORTUNITIES_SPREADSHEET_ID");
  var name = props.getProperty("OPPORTUNITIES_SHEET_NAME") || "Sheet1";
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error("Opportunities sheet not found: " + name);
  return sheet;
}

function listOpportunities_() {
  var values = opportunitiesSheet_().getDataRange().getValues();
  var rows = [];
  for (var r = 1; r < values.length; r++) { // skip header row
    var row = values[r];
    if (!String(row[1] || "") && !String(row[2] || "")) continue; // no title & no summary
    var obj = {};
    for (var c = 0; c < OPPORTUNITY_FIELDS.length; c++) {
      obj[OPPORTUNITY_FIELDS[c]] = String(row[c] == null ? "" : row[c]);
    }
    rows.push(obj);
  }
  return rows;
}

function checkRoster_(body) {
  var email = String(body.email || "").trim().toLowerCase();
  if (!email) throw new Error("email is required");
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("ROSTER_SPREADSHEET_ID");
  if (!id) throw new Error("ROSTER_SPREADSHEET_ID is not configured");
  var name = props.getProperty("ROSTER_SHEET_NAME") || "Form Responses 1";
  var sheet = SpreadsheetApp.openById(id).getSheetByName(name);
  if (!sheet) throw new Error("Roster sheet not found: " + name);

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return { member: false };
  var headers = values[0].map(function (h) { return String(h).toLowerCase(); });
  var col = function (needle) {
    for (var i = 0; i < headers.length; i++) {
      if (headers[i].indexOf(needle) !== -1) return i;
    }
    return -1;
  };
  var emailCol = col("email");
  var firstCol = col("first name");
  var lastCol = col("last name");
  var schoolCol = col("institution");
  var roleCol = col("editorial");
  if (emailCol === -1) throw new Error("No email column found on roster sheet");

  for (var r = 1; r < values.length; r++) {
    if (String(values[r][emailCol]).trim().toLowerCase() === email) {
      var nameParts = [];
      if (firstCol !== -1) nameParts.push(String(values[r][firstCol]).trim());
      if (lastCol !== -1) nameParts.push(String(values[r][lastCol]).trim());
      return {
        member: true,
        name: nameParts.join(" ").trim(),
        school: schoolCol !== -1 ? String(values[r][schoolCol]).trim() : "",
        role: roleCol !== -1 ? String(values[r][roleCol]).trim() : "",
      };
    }
  }
  return { member: false };
}

function searchExistingOpportunities_(body) {
  var needles = ["title", "oneSentenceClaim", "domain", "jurisdiction", "beneficiaries", "suspectedLegalIssues"]
    .map(function (k) { return String(body[k] || "").toLowerCase(); })
    .join(" ")
    .split(/[^a-z0-9]+/)
    .filter(function (w) { return w.length > 3; });

  var results = [];
  listOpportunities_().forEach(function (opp) {
    var hay = (opp.title + " " + opp.summary + " " + opp.domain + " " + opp.beneficiaries + " " + opp.geoScope).toLowerCase();
    var score = scoreNeedles_(hay, needles);
    if (score > 0) {
      results.push({
        title: opp.title, summary: opp.summary, domain: opp.domain,
        deploymentStage: opp.deploymentStage, source: "opportunity", score: score,
      });
    }
  });
  var prospects = readRows_(getOrCreateSheet_("Prospects", PROSPECT_HEADERS), PROSPECT_HEADERS);
  prospects.forEach(function (p) {
    var hay = (p.opportunityTitle + " " + p.oneSentenceClaim + " " + p.domain + " " + p.jurisdiction).toLowerCase();
    var score = scoreNeedles_(hay, needles);
    if (score > 0) {
      results.push({
        title: p.opportunityTitle, summary: p.oneSentenceClaim, domain: p.domain,
        deploymentStage: "Prospect (" + (p.status || "pending") + ")", source: "prospect", score: score,
      });
    }
  });
  results.sort(function (a, b) { return b.score - a.score; });
  return results.slice(0, 8);
}

function scoreNeedles_(haystack, needles) {
  var score = 0;
  for (var i = 0; i < needles.length; i++) {
    if (haystack.indexOf(needles[i]) !== -1) score++;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function createProspect_(body) {
  var sheet = getOrCreateSheet_("Prospects", PROSPECT_HEADERS);
  var prospectId = "P-" + pad_(sheet.getLastRow(), 4);
  appendRow_(sheet, PROSPECT_HEADERS, {
    prospectId: prospectId,
    createdAt: new Date().toISOString(),
    studentName: body.studentName, school: body.school, email: body.email,
    opportunityTitle: body.opportunityTitle, oneSentenceClaim: body.oneSentenceClaim,
    domain: body.domain, jurisdiction: body.jurisdiction, sourceLinks: body.sourceLinks,
    status: "New",
  });
  return { prospectId: prospectId };
}

function updateProspectStatus_(body) {
  var sheet = getOrCreateSheet_("Prospects", PROSPECT_HEADERS);
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(body.prospectId)) {
      var updates = {
        status: body.status,
        closestExistingMatches: body.closestExistingMatches,
        triageDecision: body.triageDecision,
        aiTriageConfidence: body.aiTriageConfidence,
        assignedMemoType: body.assignedMemoType,
        requestedChangeOrDirection: body.requestedChangeOrDirection,
        notes: body.notes,
      };
      for (var key in updates) {
        if (updates[key] === undefined) continue;
        var c = PROSPECT_HEADERS.indexOf(key);
        if (c !== -1) sheet.getRange(r + 1, c + 1).setValue(updates[key]);
      }
      return { updated: true };
    }
  }
  throw new Error("Prospect not found: " + body.prospectId);
}

function createAssignment_(body) {
  var sheet = getOrCreateSheet_("Assignments", ASSIGNMENT_HEADERS);
  var assignmentId = "A-" + pad_(sheet.getLastRow(), 4);
  appendRow_(sheet, ASSIGNMENT_HEADERS, {
    assignmentId: assignmentId,
    createdAt: new Date().toISOString(),
    prospectId: body.prospectId, studentName: body.studentName, school: body.school,
    assignedMemoType: body.assignedMemoType, dueDate: body.dueDate,
    requiredFocusAreas: body.requiredFocusAreas, requiredPrimaryLaw: body.requiredPrimaryLaw,
    opportunityId: body.opportunityId, notes: body.notes, status: "Assigned",
  });
  return { assignmentId: assignmentId };
}

function submitForHumanReview_(body) {
  var sheet = getOrCreateSheet_("Reviews", REVIEW_HEADERS);
  var reviewId = "R-" + pad_(sheet.getLastRow(), 4);
  var wordpressDraft = createWordPressDraft_(body);
  appendRow_(sheet, REVIEW_HEADERS, {
    reviewId: reviewId,
    createdAt: new Date().toISOString(),
    prospectId: body.prospectId, opportunityTitle: body.opportunityTitle,
    studentName: body.studentName, school: body.school,
    draftLink: wordpressDraft.editLink, aiRubricScore: body.aiRubricScore,
    aiSummaryForReviewer: body.aiSummaryForReviewer,
    humanReviewStatus: "Pending",
  });
  return { reviewId: reviewId };
}

function createWordPressDraft_(body) {
  var props = PropertiesService.getScriptProperties();
  var siteUrl = String(props.getProperty("WORDPRESS_SITE_URL") || "").replace(/\/$/, "");
  var username = props.getProperty("WORDPRESS_USERNAME");
  var appPassword = props.getProperty("WORDPRESS_APP_PASSWORD");
  if (!siteUrl || !username || !appPassword) {
    throw new Error("WordPress is not configured: set WORDPRESS_SITE_URL, WORDPRESS_USERNAME, and WORDPRESS_APP_PASSWORD");
  }
  if (!String(body.memoContent || "").trim()) throw new Error("memoContent is required");

  var response = UrlFetchApp.fetch(siteUrl + "/wp-json/wp/v2/posts", {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: "Basic " + Utilities.base64Encode(username + ":" + appPassword),
    },
    payload: JSON.stringify({
      title: String(body.opportunityTitle || "Untitled opportunity"),
      content: String(body.memoContent),
      status: "draft",
    }),
    muteHttpExceptions: true,
  });
  var status = response.getResponseCode();
  var responseBody = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error("WordPress draft creation failed (" + status + "): " + responseBody.slice(0, 500));
  }

  var post = JSON.parse(responseBody);
  var editLink = post._links && post._links.edit && post._links.edit[0] && post._links.edit[0].href;
  if (!editLink && post.link) editLink = post.link;
  if (!editLink) throw new Error("WordPress draft response did not include an edit link");
  return { id: post.id, editLink: editLink };
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

function getOrCreateSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readRows_(sheet, headers) {
  var values = sheet.getDataRange().getValues();
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      obj[headers[c]] = values[r][c] == null ? "" : values[r][c];
    }
    rows.push(obj);
  }
  return rows;
}

function appendRow_(sheet, headers, obj) {
  var row = headers.map(function (h) { return obj[h] == null ? "" : obj[h]; });
  sheet.appendRow(row);
}

function pad_(n, width) {
  var s = String(n);
  while (s.length < width) s = "0" + s;
  return s;
}
