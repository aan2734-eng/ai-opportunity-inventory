import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Loads appsscript/Code.gs with fake Apps Script services so its functions can
 * be exercised from `node --test`.
 *
 * Code.gs is plain ES5 that talks to Google's ambient globals
 * (PropertiesService, UrlFetchApp, Utilities, SpreadsheetApp). The harness
 * compiles the file inside a function whose parameters are those globals, so
 * every `var`/`function` it declares stays scoped to that call and nothing
 * leaks into the test process. Because the code runs in the normal realm —
 * not a `vm` context — objects it returns compare with assert.deepStrictEqual
 * as ordinary objects.
 *
 * No real HTTP request is ever made: UrlFetchApp.fetch records the call and
 * replays whatever `respondWith` queued.
 */

const CODE_GS_PATH = fileURLToPath(new URL("../../appsscript/Code.gs", import.meta.url));

/** Script Properties the harness sets unless a test overrides them. */
export const DEFAULT_PROPERTIES: Record<string, string> = {
  API_KEY: "test-api-key",
  ROSTER_SPREADSHEET_ID: "roster-sheet-id",
  OPPORTUNITIES_SPREADSHEET_ID: "opportunities-sheet-id",
  WORDPRESS_SITE_URL: "https://inventory.example.edu",
  WORDPRESS_USERNAME: "inventory-bot",
  WORDPRESS_APP_PASSWORD: "abcd EFGH 1234 ijkl",
};

/** Options object Code.gs hands to UrlFetchApp.fetch. */
export interface GasFetchOptions {
  method?: string;
  contentType?: string;
  headers?: Record<string, string>;
  payload?: string;
  muteHttpExceptions?: boolean;
}

export interface RecordedFetch {
  url: string;
  options: GasFetchOptions;
  /** `options.payload` parsed as JSON — i.e. the WordPress REST body. */
  body: Record<string, unknown>;
}

export interface QueuedResponse {
  /** HTTP status; defaults to 201, the status WordPress returns on create. */
  status?: number;
  /** Response body. Objects are JSON-stringified; strings are sent verbatim. */
  body?: unknown;
}

export interface MockSheet {
  name: string;
  /** Every row, header row included. */
  rows: unknown[][];
  frozenRows: number;
  appendRow(row: unknown[]): void;
  getLastRow(): number;
  getDataRange(): { getValues(): unknown[][] };
  setFrozenRows(count: number): void;
  getRange(row: number, column: number): { setValue(value: unknown): void };
}

export interface CodeGs {
  createWordPressDraft_(body: Record<string, unknown>): { id: unknown; editLink: string };
  submitForHumanReview_(body: Record<string, unknown>): { reviewId: string };
  REVIEW_HEADERS: string[];
  /** Everything else Code.gs declares at the top level. */
  [name: string]: unknown;
}

export interface Harness {
  /** The functions and constants declared by Code.gs. */
  script: CodeGs;
  /** Script Properties; mutate before calling to simulate misconfiguration. */
  properties: Map<string, string>;
  /** Every UrlFetchApp.fetch call, in order. */
  fetches: RecordedFetch[];
  /** The one fetch a test expects; fails loudly if there wasn't exactly one. */
  onlyFetch(): RecordedFetch;
  /** Queue the responses UrlFetchApp.fetch should return, in order. */
  respondWith(...responses: QueuedResponse[]): void;
  sheets: Map<string, MockSheet>;
  /** Data rows of a sheet as objects keyed by its header row. */
  rowsOf(sheetName: string): Record<string, unknown>[];
}

/** A WordPress REST response for a freshly created draft post. */
export function wordPressPost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4242,
    status: "draft",
    link: "https://inventory.example.edu/?p=4242",
    _links: {
      self: [{ href: "https://inventory.example.edu/wp-json/wp/v2/posts/4242" }],
      edit: [{ href: "https://inventory.example.edu/wp-admin/post.php?post=4242&action=edit" }],
    },
    ...overrides,
  };
}

function createSheet(name: string): MockSheet {
  const sheet: MockSheet = {
    name,
    rows: [],
    frozenRows: 0,
    appendRow(row) {
      sheet.rows.push([...row]);
    },
    getLastRow() {
      return sheet.rows.length;
    },
    getDataRange() {
      return { getValues: () => sheet.rows.map((row) => [...row]) };
    },
    setFrozenRows(count) {
      sheet.frozenRows = count;
    },
    getRange(row, column) {
      return {
        setValue(value) {
          const target = sheet.rows[row - 1];
          if (target) target[column - 1] = value;
        },
      };
    },
  };
  return sheet;
}

/** Names Code.gs declares at the top level, so the harness can hand them back. */
function declaredNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/^(?:function|var)\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(match[1]);
  }
  return [...names];
}

export function loadCodeGs(propertyOverrides: Record<string, string | null> = {}): Harness {
  const properties = new Map(Object.entries(DEFAULT_PROPERTIES));
  for (const [key, value] of Object.entries(propertyOverrides)) {
    if (value === null) properties.delete(key);
    else properties.set(key, value);
  }

  const fetches: RecordedFetch[] = [];
  const responses: QueuedResponse[] = [];
  const sheets = new Map<string, MockSheet>();

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key: string) => (properties.has(key) ? properties.get(key)! : null),
    }),
  };

  const UrlFetchApp = {
    fetch(url: string, options: GasFetchOptions) {
      const payload = typeof options?.payload === "string" ? options.payload : "";
      fetches.push({
        url: String(url),
        options: { ...options, headers: { ...options?.headers } },
        body: payload ? (JSON.parse(payload) as Record<string, unknown>) : {},
      });
      const queued = responses.shift() ?? { status: 201, body: wordPressPost() };
      const status = queued.status ?? 201;
      const body =
        typeof queued.body === "string" ? queued.body : JSON.stringify(queued.body ?? wordPressPost());
      return { getResponseCode: () => status, getContentText: () => body };
    },
  };

  const Utilities = {
    base64Encode: (value: string) => Buffer.from(String(value), "utf8").toString("base64"),
  };

  const spreadsheet = {
    getSheetByName: (name: string) => sheets.get(name) ?? null,
    insertSheet: (name: string) => {
      const sheet = createSheet(name);
      sheets.set(name, sheet);
      return sheet;
    },
  };

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
    openById: () => spreadsheet,
  };

  const ContentService = {
    MimeType: { JSON: "application/json" },
    createTextOutput: (text: string) => ({
      content: text,
      getContent: () => text,
      setMimeType() {
        return this;
      },
    }),
  };

  const source = readFileSync(CODE_GS_PATH, "utf8");
  const factory = new Function(
    "PropertiesService",
    "SpreadsheetApp",
    "UrlFetchApp",
    "Utilities",
    "ContentService",
    `${source}\n;return { ${declaredNames(source).join(", ")} };`,
  ) as (...services: unknown[]) => CodeGs;

  const script = factory(PropertiesService, SpreadsheetApp, UrlFetchApp, Utilities, ContentService);

  return {
    script,
    properties,
    fetches,
    onlyFetch() {
      if (fetches.length !== 1) {
        throw new Error(`expected exactly 1 UrlFetchApp.fetch call, saw ${fetches.length}`);
      }
      return fetches[0];
    },
    respondWith(...queued) {
      responses.push(...queued);
    },
    sheets,
    rowsOf(sheetName) {
      const sheet = sheets.get(sheetName);
      if (!sheet) return [];
      const [headers = [], ...dataRows] = sheet.rows;
      return dataRows.map((row) => {
        const entry: Record<string, unknown> = {};
        headers.forEach((header, index) => {
          entry[String(header)] = row[index];
        });
        return entry;
      });
    },
  };
}
