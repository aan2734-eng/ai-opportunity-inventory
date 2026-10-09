import type { Opportunity } from "./types";
import { listOpportunities } from "./appsScript";

const TTL_MS = 15 * 60 * 1000;

let cached: { at: number; data: Opportunity[] } | null = null;

/** Opportunities from the Raw Opportunity Bank, cached per server instance. */
export async function getOpportunities(): Promise<Opportunity[]> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;
  const data = await listOpportunities();
  cached = { at: Date.now(), data };
  return data;
}

/**
 * The bank for the pages that list it (/ and /inventory). Next caches those
 * pages and refreshes them in the background on their `revalidate` schedule,
 * so this skips the per-instance cache above and asks the backend every time.
 *
 * If the backend fails, a background refresh rethrows so Next keeps serving
 * the last good page. Only `next build` gets null instead, so a backend
 * hiccup can't fail a deploy: the page renders its fallback until the next
 * refresh succeeds.
 */
export async function getOpportunitiesForPage(): Promise<Opportunity[] | null> {
  try {
    return await listOpportunities();
  } catch (err) {
    // `next build` sets this for its prerender workers (PHASE_PRODUCTION_BUILD
    // in next/constants, which plain Node, and so `npm test`, can't import).
    if (process.env.NEXT_PHASE !== "phase-production-build") throw err;
    console.error("Opportunity bank unavailable during build:", err);
    return null;
  }
}

export function uniqueValues(opps: Opportunity[], field: keyof Opportunity): string[] {
  const seen = new Set<string>();
  for (const opp of opps) {
    const value = (opp[field] || "").trim();
    if (value) seen.add(value);
  }
  return [...seen].sort();
}
