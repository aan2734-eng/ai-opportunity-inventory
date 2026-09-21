import type Anthropic from "@anthropic-ai/sdk";
import type { Session } from "./types";
import * as backend from "./appsScript";
import { getOpportunities } from "./inventory";

/**
 * Workflow tools for the assistant. Read tools are always registered; write
 * tools are registered ONLY when the request carries a verified member
 * session — gating is a code path, not a prompt instruction. The server
 * stamps the member's identity from the session onto write actions so the
 * model can't submit on someone else's behalf.
 */

type Executor = (input: Record<string, unknown>, session: Session | null) => Promise<string>;

interface WorkflowTool {
  definition: Anthropic.Tool;
  memberOnly: boolean;
  label: string; // shown in the UI while the tool runs
  execute: Executor;
}

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string) : "";

const num = (input: Record<string, unknown>, key: string): number =>
  typeof input[key] === "number" ? (input[key] as number) : Number(input[key]) || 0;

const TOOLS: WorkflowTool[] = [
  {
    memberOnly: false,
    label: "Browsing the opportunity bank",
    definition: {
      name: "list_opportunities",
      description:
        "List every entry currently in the public Raw Opportunity Bank. Use this to answer questions about what is in the inventory, to summarize it, or to browse by domain. Returns all fields for each entry.",
      input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
    },
    execute: async () => {
      const opps = await getOpportunities();
      return JSON.stringify(opps);
    },
  },
  {
    memberOnly: false,
    label: "Searching for similar opportunities",
    definition: {
      name: "search_existing_opportunities",
      description:
        "Search the Raw Opportunity Bank and pending prospects for entries similar to a proposed AI opportunity. ALWAYS run this before classifying a new proposal — duplicate search is mandatory. Provide as many fields as you have.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Candidate opportunity title" },
          oneSentenceClaim: { type: "string", description: "One-sentence opportunity claim" },
          domain: { type: "string", description: "Societal domain, e.g. Access to Justice" },
          jurisdiction: { type: "string", description: "Geographic or legal jurisdiction" },
          beneficiaries: { type: "string", description: "Primary beneficiary group" },
          suspectedLegalIssues: { type: "string", description: "Suspected legal or policy issues" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
    execute: async (input) => {
      const matches = await backend.searchExistingOpportunities({
        title: str(input, "title"),
        oneSentenceClaim: str(input, "oneSentenceClaim"),
        domain: str(input, "domain"),
        jurisdiction: str(input, "jurisdiction"),
        beneficiaries: str(input, "beneficiaries"),
        suspectedLegalIssues: str(input, "suspectedLegalIssues"),
      });
      return JSON.stringify({ matches });
    },
  },
  {
    memberOnly: true,
    label: "Recording the prospect",
    definition: {
      name: "create_prospect",
      description:
        "Record a new AI opportunity prospect after the mandatory duplicate search. The student's name, school, and email are taken from their verified session automatically.",
      input_schema: {
        type: "object" as const,
        properties: {
          opportunityTitle: { type: "string" },
          oneSentenceClaim: { type: "string" },
          domain: { type: "string" },
          jurisdiction: { type: "string" },
          sourceLinks: { type: "string", description: "Source link or newline-separated links" },
        },
        required: ["opportunityTitle", "oneSentenceClaim", "domain", "jurisdiction", "sourceLinks"],
        additionalProperties: false,
      },
    },
    execute: async (input, session) => {
      const result = await backend.createProspect({
        studentName: session!.name || session!.email,
        school: session!.school,
        email: session!.email,
        opportunityTitle: str(input, "opportunityTitle"),
        oneSentenceClaim: str(input, "oneSentenceClaim"),
        domain: str(input, "domain"),
        jurisdiction: str(input, "jurisdiction"),
        sourceLinks: str(input, "sourceLinks"),
      });
      return JSON.stringify(result);
    },
  },
  {
    memberOnly: true,
    label: "Updating triage status",
    definition: {
      name: "update_prospect_status",
      description:
        "Record the triage outcome for a prospect. Always include every field. Status must be one of: 'Approved for memo', 'Duplicate', 'Variant - revise direction', 'Needs more information', 'Rejected'.",
      input_schema: {
        type: "object" as const,
        properties: {
          prospectId: { type: "string", description: "Prospect ID, such as P-0003" },
          status: {
            type: "string",
            enum: [
              "Approved for memo",
              "Duplicate",
              "Variant - revise direction",
              "Needs more information",
              "Rejected",
            ],
          },
          closestExistingMatches: { type: "string" },
          triageDecision: { type: "string", description: "Triage decision reasoning" },
          aiTriageConfidence: { type: "number", description: "Confidence from 0 to 1" },
          assignedMemoType: { type: "string" },
          notes: { type: "string" },
          requestedChangeOrDirection: { type: "string", description: "Requested change or new direction, if any" },
        },
        required: [
          "prospectId",
          "status",
          "closestExistingMatches",
          "triageDecision",
          "aiTriageConfidence",
          "assignedMemoType",
          "notes",
        ],
        additionalProperties: false,
      },
    },
    execute: async (input) => {
      const result = await backend.updateProspectStatus({
        prospectId: str(input, "prospectId"),
        status: str(input, "status"),
        closestExistingMatches: str(input, "closestExistingMatches"),
        triageDecision: str(input, "triageDecision"),
        aiTriageConfidence: num(input, "aiTriageConfidence"),
        assignedMemoType: str(input, "assignedMemoType"),
        notes: str(input, "notes"),
        requestedChangeOrDirection: str(input, "requestedChangeOrDirection"),
      });
      return JSON.stringify(result);
    },
  },
  {
    memberOnly: true,
    label: "Creating the memo assignment",
    definition: {
      name: "create_assignment",
      description:
        "Create a memo assignment for a prospect whose status is 'Approved for memo'. The student's name and school come from their verified session.",
      input_schema: {
        type: "object" as const,
        properties: {
          prospectId: { type: "string" },
          assignedMemoType: { type: "string" },
          dueDate: { type: "string", description: "YYYY-MM-DD" },
          requiredFocusAreas: { type: "string" },
          requiredPrimaryLaw: { type: "string", description: "Required primary legal authority instructions" },
          opportunityId: { type: "string", description: "Optional linked canonical opportunity ID" },
          notes: { type: "string" },
        },
        required: ["prospectId", "assignedMemoType"],
        additionalProperties: false,
      },
    },
    execute: async (input, session) => {
      const result = await backend.createAssignment({
        prospectId: str(input, "prospectId"),
        studentName: session!.name || session!.email,
        school: session!.school,
        assignedMemoType: str(input, "assignedMemoType"),
        dueDate: str(input, "dueDate"),
        requiredFocusAreas: str(input, "requiredFocusAreas"),
        requiredPrimaryLaw: str(input, "requiredPrimaryLaw"),
        opportunityId: str(input, "opportunityId"),
        notes: str(input, "notes"),
      });
      return JSON.stringify(result);
    },
  },
  {
    memberOnly: true,
    label: "Submitting for human review",
    definition: {
      name: "submit_for_human_review",
      description:
        "Submit a finished memo draft to the editorial review queue. Only use after the draft meets every precondition in the human review standard. The student's identity comes from their verified session.",
      input_schema: {
        type: "object" as const,
        properties: {
          prospectId: { type: "string" },
          opportunityTitle: { type: "string" },
          memoContent: {
            type: "string",
            description: "Complete memo body as HTML for the WordPress draft. Preserve the student's analysis and section structure.",
          },
          aiRubricScore: { type: "number", description: "Rubric score from 0 to 100" },
          aiSummaryForReviewer: {
            type: "string",
            description:
              "Summary for the human reviewer: duplicate-check outcome, main legal/policy issues, weaknesses needing reviewer attention, recommended review status.",
          },
        },
        required: ["prospectId", "opportunityTitle", "memoContent", "aiRubricScore", "aiSummaryForReviewer"],
        additionalProperties: false,
      },
    },
    execute: async (input, session) => {
      const result = await backend.submitForHumanReview({
        prospectId: str(input, "prospectId"),
        opportunityTitle: str(input, "opportunityTitle"),
        studentName: session!.name || session!.email,
        school: session!.school,
        memoContent: str(input, "memoContent"),
        aiRubricScore: num(input, "aiRubricScore"),
        aiSummaryForReviewer: str(input, "aiSummaryForReviewer"),
      });
      return JSON.stringify(result);
    },
  },
];

export function toolsForSession(session: Session | null): WorkflowTool[] {
  return TOOLS.filter((t) => !t.memberOnly || session !== null);
}

export function findTool(name: string, session: Session | null): WorkflowTool | undefined {
  return toolsForSession(session).find((t) => t.definition.name === name);
}
