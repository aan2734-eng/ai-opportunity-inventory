import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * How the pages that list the Raw Opportunity Bank (/ and /inventory) read it:
 * lib/appsScript.ts picks the fetch cache mode, which decides whether Next can
 * prerender those pages at all, and lib/inventory.ts decides what a backend
 * failure does to them.
 *
 * lib/appsScript.ts reads APPS_SCRIPT_URL / APPS_SCRIPT_SECRET at import time,
 * so the env is set before the dynamic imports below.
 */

process.env.APPS_SCRIPT_URL = "https://script.google.test/macros/s/deployment/exec";
process.env.APPS_SCRIPT_SECRET = "shared-secret";

const backend = await import("../lib/appsScript.ts");
const { getOpportunitiesForPage } = await import("../lib/inventory.ts");

delete process.env.APPS_SCRIPT_URL;
delete process.env.APPS_SCRIPT_SECRET;

const BANK = [{ title: "Automated benefits screening", domain: "Social services" }];

interface BackendRequest {
  init: RequestInit;
  body: Record<string, unknown>;
}

const requests: BackendRequest[] = [];

/** Stubs global fetch so no request leaves the test process. */
function stubBackend(response: unknown, { ok = true, status = 200 } = {}) {
  requests.length = 0;
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    requests.push({ init, body: JSON.parse(String(init.body)) });
    return { ok, status, json: async () => response } as Response;
  });
}

afterEach(() => {
  mock.restoreAll();
  delete process.env.NEXT_PHASE;
});

describe("listOpportunities", () => {
  it("leaves the fetch in Next's default cache mode", async () => {
    stubBackend({ ok: true, data: BANK });

    assert.deepEqual(await backend.listOpportunities(), BANK);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.action, "listOpportunities");
    // "no-store" would make / and /inventory render on every visit, each one
    // waiting on Apps Script, instead of being prerendered.
    assert.equal((requests[0].init as RequestInit & { cache?: string }).cache, "default");
  });
});

describe("getOpportunitiesForPage", () => {
  it("asks the backend every time instead of reusing the per-instance cache", async () => {
    stubBackend({ ok: true, data: BANK });

    assert.deepEqual(await getOpportunitiesForPage(), BANK);
    assert.deepEqual(await getOpportunitiesForPage(), BANK);

    assert.equal(requests.length, 2);
  });

  it("rethrows a backend failure so a background refresh keeps the last good page", async () => {
    stubBackend({ ok: false, error: "Unauthorized" });

    await assert.rejects(getOpportunitiesForPage(), /Unauthorized/);
  });

  it("returns null during `next build` so a backend failure can't fail the deploy", async () => {
    stubBackend({}, { ok: false, status: 502 });
    mock.method(console, "error", () => {});
    process.env.NEXT_PHASE = "phase-production-build";

    assert.equal(await getOpportunitiesForPage(), null);
  });
});
