import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import type { Session } from "../lib/types.ts";

/**
 * The site half of the WordPress draft payload: the `submit_for_human_review`
 * tool in lib/tools.ts and the backend client in lib/appsScript.ts, which
 * together decide what appsscript/Code.gs receives before it builds the draft.
 *
 * lib/appsScript.ts reads APPS_SCRIPT_URL / APPS_SCRIPT_SECRET at import time,
 * so the env is set before the dynamic imports below, and the unconfigured
 * (mock backend) copy is imported under a distinct specifier.
 */

const APPS_SCRIPT_URL = "https://script.google.test/macros/s/deployment/exec";
const APPS_SCRIPT_SECRET = "shared-secret";

process.env.APPS_SCRIPT_URL = APPS_SCRIPT_URL;
process.env.APPS_SCRIPT_SECRET = APPS_SCRIPT_SECRET;

const { findTool, toolsForSession } = await import("../lib/tools.ts");
const backend = await import("../lib/appsScript.ts");

delete process.env.APPS_SCRIPT_URL;
delete process.env.APPS_SCRIPT_SECRET;
// The query string is only a cache buster: it gives a second, unconfigured
// copy of the module. Held in a variable so TypeScript does not try to resolve it.
const UNCONFIGURED_BACKEND = "../lib/appsScript.ts?unconfigured=1";
const mockBackend: typeof backend = await import(UNCONFIGURED_BACKEND);

const MEMO_HTML = "<h2>1. Opportunity claim</h2><p>Benefits screening for SNAP recipients.</p>";

const SESSION: Session = {
  email: "student@law.utexas.edu",
  name: "Jordan Rivera",
  school: "UT Austin",
  role: "Submitter",
  iat: Date.now(),
};

interface BackendRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

const requests: BackendRequest[] = [];

/** Stubs global fetch so no request leaves the test process. */
function stubBackend(response: unknown, { ok = true, status = 200 } = {}) {
  requests.length = 0;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    return { ok, status, json: async () => response } as Response;
  });
}

function onlyRequest(): BackendRequest {
  assert.equal(requests.length, 1, "expected exactly one backend request");
  return requests[0];
}

const submitParams = (overrides: Record<string, unknown> = {}) => ({
  prospectId: "P-0012",
  opportunityTitle: "Automated benefits screening",
  studentName: "Jordan Rivera",
  school: "UT Austin",
  memoContent: MEMO_HTML,
  aiRubricScore: 91,
  aiSummaryForReviewer: "Duplicate check clean; watch the due-process analysis in §4.",
  ...overrides,
});

afterEach(() => mock.restoreAll());

describe("submitForHumanReview — what reaches Apps Script", () => {
  it("posts the submitForHumanReview action with the shared secret", async () => {
    stubBackend({ ok: true, data: { reviewId: "R-0004" } });

    const result = await backend.submitForHumanReview(submitParams());

    const request = onlyRequest();
    assert.equal(request.url, APPS_SCRIPT_URL);
    assert.equal(request.init.method, "POST");
    assert.deepEqual(request.init.headers, { "Content-Type": "application/json" });
    // Apps Script answers through a one-time redirect URL; a cached response
    // would hand a second student the first student's review id.
    assert.equal((request.init as RequestInit & { cache?: string }).cache, "no-store");
    assert.equal(request.body.secret, APPS_SCRIPT_SECRET);
    assert.equal(request.body.action, "submitForHumanReview");
    assert.deepEqual(result, { reviewId: "R-0004" });
  });

  it("carries every field createWordPressDraft_ and the Reviews sheet need", async () => {
    stubBackend({ ok: true, data: { reviewId: "R-0004" } });

    await backend.submitForHumanReview(submitParams());

    const { secret, action, ...payload } = onlyRequest().body;
    assert.ok(secret && action);
    assert.deepEqual(payload, submitParams());
  });

  it("sends the memo HTML unescaped and untruncated", async () => {
    stubBackend({ ok: true, data: { reviewId: "R-0004" } });
    const memoContent = `<p>${"Long section. ".repeat(500)}</p><p>Cite: 7 C.F.R. §273.2 &amp; "the Act"</p>`;

    await backend.submitForHumanReview(submitParams({ memoContent }));

    assert.equal(onlyRequest().body.memoContent, memoContent);
  });

  it("fails loudly when the Apps Script request itself fails", async () => {
    stubBackend({}, { ok: false, status: 502 });

    await assert.rejects(
      () => backend.submitForHumanReview(submitParams()),
      /Backend request failed \(502\)/,
    );
  });

  it("surfaces the WordPress failure the backend reports", async () => {
    stubBackend({ ok: false, error: "WordPress draft creation failed (401): rest_cannot_create" });

    await assert.rejects(
      () => backend.submitForHumanReview(submitParams()),
      /WordPress draft creation failed \(401\)/,
    );
  });

  it("falls back to a generic message when the backend sends no reason", async () => {
    stubBackend({ ok: false });

    await assert.rejects(() => backend.submitForHumanReview(submitParams()), /Backend returned an error/);
  });
});

describe("submit_for_human_review tool", () => {
  const tool = () => findTool("submit_for_human_review", SESSION)!;

  it("is hidden from visitors without a verified session", () => {
    assert.equal(findTool("submit_for_human_review", null), undefined);
    assert.ok(!toolsForSession(null).some((t) => t.definition.name === "submit_for_human_review"));
    assert.ok(tool());
  });

  it("requires the memo HTML and refuses unknown fields", () => {
    const schema = tool().definition.input_schema as unknown as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { description?: string }>;
    };

    assert.deepEqual(schema.required.toSorted(), [
      "aiRubricScore",
      "aiSummaryForReviewer",
      "memoContent",
      "opportunityTitle",
      "prospectId",
    ]);
    assert.equal(schema.additionalProperties, false);
    assert.match(String(schema.properties.memoContent.description), /HTML/);
  });

  it("stamps the submitter from the session, not from the model's arguments", async () => {
    stubBackend({ ok: true, data: { reviewId: "R-0005" } });

    const result = await tool().execute(
      {
        prospectId: "P-0012",
        opportunityTitle: "Automated benefits screening",
        memoContent: MEMO_HTML,
        aiRubricScore: 91,
        aiSummaryForReviewer: "Duplicate check clean.",
        // A prompt-injected attempt to submit as someone else.
        studentName: "Someone Else",
        school: "Another School",
        email: "attacker@example.com",
      },
      SESSION,
    );

    const body = onlyRequest().body;
    assert.equal(body.studentName, "Jordan Rivera");
    assert.equal(body.school, "UT Austin");
    assert.ok(!("email" in body));
    assert.equal(body.memoContent, MEMO_HTML);
    assert.equal(result, JSON.stringify({ reviewId: "R-0005" }));
  });

  it("uses the member's email when the roster has no name for them", async () => {
    stubBackend({ ok: true, data: { reviewId: "R-0006" } });

    await tool().execute(
      { prospectId: "P-0012", opportunityTitle: "T", memoContent: MEMO_HTML, aiRubricScore: 80, aiSummaryForReviewer: "s" },
      { ...SESSION, name: "" },
    );

    assert.equal(onlyRequest().body.studentName, "student@law.utexas.edu");
  });

  it("coerces a rubric score the model sent as a string", async () => {
    stubBackend({ ok: true, data: { reviewId: "R-0007" } });

    await tool().execute(
      { prospectId: "P-0012", opportunityTitle: "T", memoContent: MEMO_HTML, aiRubricScore: "91", aiSummaryForReviewer: "s" },
      SESSION,
    );

    assert.equal(onlyRequest().body.aiRubricScore, 91);
  });

  it("sends an empty memo through as empty so the backend can reject it", async () => {
    stubBackend({ ok: true, data: { reviewId: "R-0008" } });

    await tool().execute(
      { prospectId: "P-0012", opportunityTitle: "T", aiRubricScore: 80, aiSummaryForReviewer: "s" },
      SESSION,
    );

    // createWordPressDraft_ is the guard; see wordpressDraft.test.ts.
    assert.equal(onlyRequest().body.memoContent, "");
  });
});

describe("mock backend (no APPS_SCRIPT_URL configured)", () => {
  it("issues review ids without calling out to anything", async () => {
    stubBackend({ ok: true, data: { reviewId: "unused" } });

    assert.deepEqual(await mockBackend.submitForHumanReview(submitParams()), { reviewId: "R-0001" });
    assert.deepEqual(await mockBackend.submitForHumanReview(submitParams()), { reviewId: "R-0002" });
    assert.equal(requests.length, 0);
    assert.equal(mockBackend.backendConfigured, false);
  });
});
