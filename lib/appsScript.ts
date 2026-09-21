import type { Opportunity, RosterEntry, SearchMatch } from "./types";
import sampleOpportunities from "@/data/opportunities.sample.json";

/**
 * Client for the Google Apps Script backend (see appsscript/Code.gs and
 * HANDOFF.md). When APPS_SCRIPT_URL / APPS_SCRIPT_SECRET are not set, every
 * action runs against an in-memory mock backed by data/opportunities.sample.json
 * so the whole app works in local dev without touching Kevin's sheet.
 */

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;

export const backendConfigured = Boolean(APPS_SCRIPT_URL && APPS_SCRIPT_SECRET);

interface BackendResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function call<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!backendConfigured) {
    return mockCall<T>(action, params);
  }
  const res = await fetch(APPS_SCRIPT_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: APPS_SCRIPT_SECRET, action, ...params }),
    // Apps Script /exec answers via a 302 to a one-time content URL; fetch
    // follows it by default. Never cache backend responses.
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Backend request failed (${res.status})`);
  }
  const body = (await res.json()) as BackendResponse<T>;
  if (!body.ok) {
    throw new Error(body.error || "Backend returned an error");
  }
  return body.data as T;
}

// ---------------------------------------------------------------------------
// Public API used by routes and tools
// ---------------------------------------------------------------------------

export async function listOpportunities(): Promise<Opportunity[]> {
  return call<Opportunity[]>("listOpportunities");
}

export async function checkRoster(email: string): Promise<RosterEntry> {
  return call<RosterEntry>("checkRoster", { email: email.trim().toLowerCase() });
}

export interface SearchParams {
  title: string;
  oneSentenceClaim?: string;
  domain?: string;
  jurisdiction?: string;
  beneficiaries?: string;
  suspectedLegalIssues?: string;
}

export async function searchExistingOpportunities(params: SearchParams): Promise<SearchMatch[]> {
  return call<SearchMatch[]>("searchExistingOpportunities", { ...params });
}

export interface CreateProspectParams {
  studentName: string;
  school: string;
  email: string;
  opportunityTitle: string;
  oneSentenceClaim: string;
  domain: string;
  jurisdiction: string;
  sourceLinks: string;
}

export async function createProspect(params: CreateProspectParams): Promise<{ prospectId: string }> {
  return call<{ prospectId: string }>("createProspect", { ...params });
}

export interface UpdateProspectStatusParams {
  prospectId: string;
  status: string;
  closestExistingMatches: string;
  triageDecision: string;
  aiTriageConfidence: number;
  assignedMemoType: string;
  notes: string;
  requestedChangeOrDirection?: string;
}

export async function updateProspectStatus(params: UpdateProspectStatusParams): Promise<{ updated: boolean }> {
  return call<{ updated: boolean }>("updateProspectStatus", { ...params });
}

export interface CreateAssignmentParams {
  prospectId: string;
  studentName: string;
  school: string;
  assignedMemoType: string;
  dueDate?: string;
  requiredFocusAreas?: string;
  requiredPrimaryLaw?: string;
  opportunityId?: string;
  notes?: string;
}

export async function createAssignment(params: CreateAssignmentParams): Promise<{ assignmentId: string }> {
  return call<{ assignmentId: string }>("createAssignment", { ...params });
}

export interface SubmitForHumanReviewParams {
  prospectId: string;
  opportunityTitle: string;
  studentName: string;
  school: string;
  memoContent: string;
  aiRubricScore: number;
  aiSummaryForReviewer: string;
}

export async function submitForHumanReview(params: SubmitForHumanReviewParams): Promise<{ reviewId: string }> {
  return call<{ reviewId: string }>("submitForHumanReview", { ...params });
}

// ---------------------------------------------------------------------------
// Mock backend (dev only) — mirrors the drafted Apps Script contract
// ---------------------------------------------------------------------------

const mockProspects: Array<Record<string, unknown> & { prospectId: string }> = [];
const mockAssignments: Array<Record<string, unknown> & { assignmentId: string }> = [];
const mockReviews: Array<Record<string, unknown> & { reviewId: string }> = [];

function devRoster(): Map<string, { name: string; school: string; role: string }> {
  // DEV_ROSTER="jane@example.com|Jane Doe|Vanderbilt|Submitter,ed@x.edu|Ed|UT|Editor"
  const raw = process.env.DEV_ROSTER || "test@example.com|Test Student|Vanderbilt|Submitter";
  const map = new Map<string, { name: string; school: string; role: string }>();
  for (const entry of raw.split(",")) {
    const [email, name = "Member", school = "", role = "Submitter"] = entry.split("|");
    if (email) map.set(email.trim().toLowerCase(), { name, school, role });
  }
  return map;
}

function keywordScore(haystack: string, needles: string[]): number {
  const text = haystack.toLowerCase();
  let score = 0;
  for (const needle of needles) {
    if (needle.length > 2 && text.includes(needle)) score += 1;
  }
  return score;
}

function mockSearch(params: Record<string, unknown>): SearchMatch[] {
  const needles = Object.values(params)
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => v.toLowerCase().split(/[^a-z0-9]+/))
    .filter((w) => w.length > 3);
  const results: SearchMatch[] = [];
  for (const opp of sampleOpportunities as Opportunity[]) {
    const score = keywordScore(
      `${opp.title} ${opp.summary} ${opp.domain} ${opp.beneficiaries} ${opp.geoScope}`,
      needles,
    );
    if (score > 0) {
      results.push({
        title: opp.title,
        summary: opp.summary,
        domain: opp.domain,
        deploymentStage: opp.deploymentStage,
        source: "opportunity",
        score,
      });
    }
  }
  for (const p of mockProspects) {
    const score = keywordScore(`${p.opportunityTitle} ${p.oneSentenceClaim} ${p.domain}`, needles);
    if (score > 0) {
      results.push({
        title: String(p.opportunityTitle),
        summary: String(p.oneSentenceClaim),
        domain: String(p.domain),
        deploymentStage: "Prospect",
        source: "prospect",
        score,
      });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 8);
}

async function mockCall<T>(action: string, params: Record<string, unknown>): Promise<T> {
  switch (action) {
    case "listOpportunities":
      return sampleOpportunities as T;
    case "checkRoster": {
      const entry = devRoster().get(String(params.email));
      return (entry ? { member: true, ...entry } : { member: false }) as T;
    }
    case "searchExistingOpportunities":
      return mockSearch(params) as T;
    case "createProspect": {
      const prospectId = `P-${String(mockProspects.length + 1).padStart(4, "0")}`;
      mockProspects.push({ prospectId, ...params, createdAt: new Date().toISOString() });
      return { prospectId } as T;
    }
    case "updateProspectStatus": {
      const prospect = mockProspects.find((p) => p.prospectId === params.prospectId);
      if (prospect) Object.assign(prospect, params);
      return { updated: Boolean(prospect) } as T;
    }
    case "createAssignment": {
      const assignmentId = `A-${String(mockAssignments.length + 1).padStart(4, "0")}`;
      mockAssignments.push({ assignmentId, ...params, createdAt: new Date().toISOString() });
      return { assignmentId } as T;
    }
    case "submitForHumanReview": {
      const reviewId = `R-${String(mockReviews.length + 1).padStart(4, "0")}`;
      mockReviews.push({
        reviewId,
        ...params,
        draftLink: "https://wordpress.example.test/wp-admin/post.php?post=" + reviewId,
        createdAt: new Date().toISOString(),
        humanReviewStatus: "Pending",
      });
      return { reviewId } as T;
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
