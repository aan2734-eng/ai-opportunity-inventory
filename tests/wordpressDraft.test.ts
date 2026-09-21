import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_PROPERTIES, loadCodeGs, wordPressPost } from "./helpers/appsScriptHarness.ts";

/**
 * appsscript/Code.gs — createWordPressDraft_ and its caller
 * submitForHumanReview_.
 *
 * This is the one place where the project writes to an outside system, so the
 * tests pin down the exact request: where it goes, how it authenticates, what
 * the post body contains, and what happens when WordPress says no. Every call
 * runs against the fake UrlFetchApp in tests/helpers/appsScriptHarness.ts.
 */

const MEMO_HTML =
  '<h2>1. Opportunity claim</h2><p>County courts can triage <em>pro se</em> filings with a ' +
  'retrieval-assisted classifier.</p><h2>2. Public problem</h2><p>Self-represented litigants ' +
  "wait 14&ndash;18 months for a first hearing.</p>";

function draftBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prospectId: "P-0007",
    opportunityTitle: "AI triage for pro se filings",
    studentName: "Test Student",
    school: "UT Austin",
    memoContent: MEMO_HTML,
    aiRubricScore: 88,
    aiSummaryForReviewer: "No duplicates found. Main issue: UPL exposure under Tex. Gov't Code.",
    ...overrides,
  };
}

describe("createWordPressDraft_ — request shape", () => {
  it("posts to the site's wp/v2/posts endpoint", () => {
    const gas = loadCodeGs();

    gas.script.createWordPressDraft_(draftBody());

    const call = gas.onlyFetch();
    assert.equal(call.url, "https://inventory.example.edu/wp-json/wp/v2/posts");
    assert.equal(call.options.method, "post");
    assert.equal(call.options.contentType, "application/json");
    // Without this, Apps Script throws on 4xx/5xx before the code can read the
    // response body into a useful error message.
    assert.equal(call.options.muteHttpExceptions, true);
  });

  it("strips a trailing slash from WORDPRESS_SITE_URL", () => {
    const gas = loadCodeGs({ WORDPRESS_SITE_URL: "https://inventory.example.edu/" });

    gas.script.createWordPressDraft_(draftBody());

    assert.equal(gas.onlyFetch().url, "https://inventory.example.edu/wp-json/wp/v2/posts");
  });

  it("authenticates with a Basic header built from the application password", () => {
    const gas = loadCodeGs();

    gas.script.createWordPressDraft_(draftBody());

    const expected = Buffer.from(
      `${DEFAULT_PROPERTIES.WORDPRESS_USERNAME}:${DEFAULT_PROPERTIES.WORDPRESS_APP_PASSWORD}`,
      "utf8",
    ).toString("base64");
    assert.equal(gas.onlyFetch().options.headers?.Authorization, `Basic ${expected}`);
  });

  it("keeps the application password out of the URL and the post body", () => {
    const gas = loadCodeGs();

    gas.script.createWordPressDraft_(draftBody());

    const call = gas.onlyFetch();
    const password = DEFAULT_PROPERTIES.WORDPRESS_APP_PASSWORD;
    assert.ok(!call.url.includes(password), "credential leaked into the request URL");
    assert.ok(!(call.options.payload ?? "").includes(password), "credential leaked into the payload");
  });

  it("sends exactly title, content and status — and always status draft", () => {
    const gas = loadCodeGs();

    gas.script.createWordPressDraft_(draftBody());

    // Nothing may be published straight to the site: editors decide.
    assert.deepEqual(gas.onlyFetch().body, {
      title: "AI triage for pro se filings",
      content: MEMO_HTML,
      status: "draft",
    });
  });

  it("passes the memo HTML through untouched", () => {
    const gas = loadCodeGs();
    const memoContent =
      '<p>Quote: "the court shall" &amp; §411.081 — see <a href="https://example.gov/x?a=1&b=2">the order</a>.</p>' +
      "<p>Unicode survives: café, 数据, 🇺🇸</p>";

    gas.script.createWordPressDraft_(draftBody({ memoContent }));

    assert.equal(gas.onlyFetch().body.content, memoContent);
  });

  it("falls back to a placeholder title when the title is missing or empty", () => {
    for (const opportunityTitle of [undefined, "", null]) {
      const gas = loadCodeGs();

      gas.script.createWordPressDraft_(draftBody({ opportunityTitle }));

      assert.equal(gas.onlyFetch().body.title, "Untitled opportunity");
    }
  });

  it("coerces a non-string title to a string", () => {
    const gas = loadCodeGs();

    gas.script.createWordPressDraft_(draftBody({ opportunityTitle: 2026 }));

    assert.equal(gas.onlyFetch().body.title, "2026");
  });
});

describe("createWordPressDraft_ — refuses to call WordPress", () => {
  for (const missing of ["WORDPRESS_SITE_URL", "WORDPRESS_USERNAME", "WORDPRESS_APP_PASSWORD"]) {
    it(`when ${missing} is not set`, () => {
      const gas = loadCodeGs({ [missing]: null });

      assert.throws(
        () => gas.script.createWordPressDraft_(draftBody()),
        /WordPress is not configured/,
      );
      assert.equal(gas.fetches.length, 0);
    });
  }

  it("when the configuration error would otherwise echo the credentials", () => {
    const gas = loadCodeGs({ WORDPRESS_SITE_URL: null });

    assert.throws(
      () => gas.script.createWordPressDraft_(draftBody()),
      (error: Error) => !error.message.includes(DEFAULT_PROPERTIES.WORDPRESS_APP_PASSWORD),
    );
  });

  it("when memoContent is missing, empty or only whitespace", () => {
    for (const memoContent of [undefined, "", "   \n\t  "]) {
      const gas = loadCodeGs();

      assert.throws(() => gas.script.createWordPressDraft_(draftBody({ memoContent })), /memoContent is required/);
      assert.equal(gas.fetches.length, 0);
    }
  });
});

describe("createWordPressDraft_ — response handling", () => {
  it("returns the post id and the edit link from _links.edit", () => {
    const gas = loadCodeGs();
    gas.respondWith({ status: 201, body: wordPressPost({ id: 777 }) });

    const result = gas.script.createWordPressDraft_(draftBody());

    assert.deepEqual(result, {
      id: 777,
      editLink: "https://inventory.example.edu/wp-admin/post.php?post=4242&action=edit",
    });
  });

  it("falls back to the public link when the response has no edit link", () => {
    const gas = loadCodeGs();
    gas.respondWith({ status: 201, body: wordPressPost({ _links: { self: [{ href: "x" }] } }) });

    const result = gas.script.createWordPressDraft_(draftBody());

    assert.equal(result.editLink, "https://inventory.example.edu/?p=4242");
  });

  it("throws when the response carries no usable link at all", () => {
    const gas = loadCodeGs();
    gas.respondWith({ status: 201, body: { id: 4242, status: "draft" } });

    assert.throws(
      () => gas.script.createWordPressDraft_(draftBody()),
      /did not include an edit link/,
    );
  });

  it("reports the status code and body when WordPress rejects the draft", () => {
    const gas = loadCodeGs();
    gas.respondWith({
      status: 401,
      body: { code: "rest_cannot_create", message: "Sorry, you are not allowed to create posts." },
    });

    assert.throws(() => gas.script.createWordPressDraft_(draftBody()), (error: Error) => {
      assert.match(error.message, /WordPress draft creation failed \(401\)/);
      assert.match(error.message, /rest_cannot_create/);
      return true;
    });
  });

  it("treats any non-2xx status as a failure", () => {
    for (const status of [301, 400, 403, 404, 500, 502]) {
      const gas = loadCodeGs();
      gas.respondWith({ status, body: "nope" });

      assert.throws(
        () => gas.script.createWordPressDraft_(draftBody()),
        new RegExp(`WordPress draft creation failed \\(${status}\\)`),
      );
    }
  });

  it("truncates a long error body to 500 characters", () => {
    const gas = loadCodeGs();
    gas.respondWith({ status: 500, body: "E".repeat(400) + "F".repeat(400) });

    assert.throws(() => gas.script.createWordPressDraft_(draftBody()), (error: Error) => {
      const reported = error.message.split("): ")[1];
      assert.equal(reported.length, 500);
      assert.ok(!reported.includes("F".repeat(101)));
      return true;
    });
  });

  it("surfaces an HTML error page instead of crashing on JSON.parse", () => {
    const gas = loadCodeGs();
    gas.respondWith({ status: 502, body: "<html><body><h1>502 Bad Gateway</h1></body></html>" });

    assert.throws(
      () => gas.script.createWordPressDraft_(draftBody()),
      /WordPress draft creation failed \(502\)/,
    );
  });
});

describe("submitForHumanReview_ — the Reviews row that links to the draft", () => {
  it("stores the WordPress edit link and queues the review as Pending", () => {
    const gas = loadCodeGs();

    const result = gas.script.submitForHumanReview_(draftBody());

    assert.deepEqual(result, { reviewId: "R-0001" });
    const [row] = gas.rowsOf("Reviews");
    assert.equal(row.reviewId, "R-0001");
    assert.equal(row.draftLink, "https://inventory.example.edu/wp-admin/post.php?post=4242&action=edit");
    assert.equal(row.humanReviewStatus, "Pending");
    assert.equal(row.prospectId, "P-0007");
    assert.equal(row.opportunityTitle, "AI triage for pro se filings");
    assert.equal(row.studentName, "Test Student");
    assert.equal(row.school, "UT Austin");
    assert.equal(row.aiRubricScore, 88);
    assert.match(String(row.createdAt), /^\d{4}-\d{2}-\d{2}T/);
  });

  it("writes the row in REVIEW_HEADERS order", () => {
    const gas = loadCodeGs();

    gas.script.submitForHumanReview_(draftBody());

    const sheet = gas.sheets.get("Reviews")!;
    assert.deepEqual(sheet.rows[0], gas.script.REVIEW_HEADERS);
    assert.equal(sheet.rows[1].length, gas.script.REVIEW_HEADERS.length);
    assert.equal(sheet.frozenRows, 1);
  });

  it("keeps the memo body in WordPress, not in the sheet", () => {
    const gas = loadCodeGs();

    gas.script.submitForHumanReview_(draftBody());

    assert.equal(gas.onlyFetch().body.content, MEMO_HTML);
    const row = gas.sheets.get("Reviews")!.rows[1];
    assert.ok(!row.some((cell) => String(cell).includes("Opportunity claim")));
  });

  it("numbers reviews sequentially", () => {
    const gas = loadCodeGs();

    assert.deepEqual(gas.script.submitForHumanReview_(draftBody()), { reviewId: "R-0001" });
    assert.deepEqual(gas.script.submitForHumanReview_(draftBody()), { reviewId: "R-0002" });
    assert.equal(gas.fetches.length, 2);
  });

  it("records no review when the draft could not be created", () => {
    const gas = loadCodeGs();
    gas.respondWith({ status: 403, body: { code: "rest_cannot_create" } });

    assert.throws(() => gas.script.submitForHumanReview_(draftBody()), /WordPress draft creation failed \(403\)/);
    // A row here would point a reviewer at a draft that does not exist.
    assert.deepEqual(gas.rowsOf("Reviews"), []);
  });
});

describe("doPost — the submitForHumanReview action end to end", () => {
  function post(gas: ReturnType<typeof loadCodeGs>, body: Record<string, unknown>) {
    const doPost = gas.script.doPost as (e: {
      postData: { contents: string };
    }) => { getContent(): string };
    return JSON.parse(doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  }

  it("creates the draft and returns the review id", () => {
    const gas = loadCodeGs();

    const response = post(gas, {
      secret: DEFAULT_PROPERTIES.API_KEY,
      action: "submitForHumanReview",
      ...draftBody(),
    });

    assert.deepEqual(response, { ok: true, data: { reviewId: "R-0001" } });
    assert.equal(gas.onlyFetch().body.status, "draft");
  });

  it("never touches WordPress when the shared secret is wrong", () => {
    const gas = loadCodeGs();

    const response = post(gas, {
      secret: "not-the-key",
      action: "submitForHumanReview",
      ...draftBody(),
    });

    assert.deepEqual(response, { ok: false, error: "Unauthorized" });
    assert.equal(gas.fetches.length, 0);
    assert.deepEqual(gas.rowsOf("Reviews"), []);
  });

  it("reports a WordPress failure as a JSON error rather than throwing", () => {
    const gas = loadCodeGs();
    gas.respondWith({ status: 500, body: "WordPress is down" });

    const response = post(gas, {
      secret: DEFAULT_PROPERTIES.API_KEY,
      action: "submitForHumanReview",
      ...draftBody(),
    });

    assert.equal(response.ok, false);
    assert.match(response.error, /WordPress draft creation failed \(500\)/);
  });
});
