import Anthropic from "@anthropic-ai/sdk";
import { cookies } from "next/headers";
import { verifySession } from "@/lib/session";
import { buildSystemPrompt } from "@/lib/systemPrompt";
import { toolsForSession, findTool } from "@/lib/tools";
import {
  CHAT_MAX_MESSAGES,
  CHAT_MAX_TOTAL_CHARS,
  CHAT_MAX_TOOL_ROUNDS,
  CLAUDE_MODEL,
  SESSION_COOKIE,
} from "@/lib/config";
import type { ChatEvent } from "@/lib/types";

export const maxDuration = 120;

// Read the key explicitly per request rather than letting the SDK pick it up
// from process.env at module load. A module-scope `new Anthropic()` captures
// whatever the env held at cold start and only fails much later, deep inside
// the stream, as "Could not resolve authentication method" — which reads like
// an SDK bug rather than an unset variable. Vercel bakes env vars into a
// deployment, so adding ANTHROPIC_API_KEY requires a redeploy of the
// environment (Production/Preview) being hit.
function anthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in this deployment's environment.");
  return new Anthropic({ apiKey });
}

// Best-effort per-IP throttle. In-memory, so it resets per serverless
// instance — the hard backstop is Anthropic console spend alerts (HANDOFF.md).
const buckets = new Map<string, { count: number; reset: number }>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 30;

function throttled(ip: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || now > bucket.reset) {
    buckets.set(ip, { count: 1, reset: now + WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > MAX_PER_WINDOW;
}

interface IncomingMessage {
  role: "user" | "assistant";
  content: string;
}

function validateMessages(raw: unknown): IncomingMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > CHAT_MAX_MESSAGES) return null;
  let total = 0;
  const messages: IncomingMessage[] = [];
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
    total += m.content.length;
    messages.push({ role: m.role, content: m.content });
  }
  if (total > CHAT_MAX_TOTAL_CHARS) return null;
  if (messages[messages.length - 1].role !== "user") return null;
  return messages;
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (throttled(ip)) {
    return Response.json(
      { error: "You've sent a lot of messages in a short time. Please wait a few minutes." },
      { status: 429 },
    );
  }

  let incoming: IncomingMessage[] | null = null;
  try {
    const body = await request.json();
    incoming = validateMessages(body.messages);
  } catch {
    /* fall through */
  }
  if (!incoming) {
    return Response.json({ error: "Invalid conversation payload." }, { status: 400 });
  }

  let anthropic: Anthropic;
  try {
    anthropic = anthropicClient();
  } catch (err) {
    console.error("chat misconfigured:", err);
    return Response.json(
      { error: "The assistant isn't configured yet. (Server: ANTHROPIC_API_KEY is missing.)" },
      { status: 500 },
    );
  }

  const cookieStore = await cookies();
  const session = verifySession(cookieStore.get(SESSION_COOKIE)?.value);

  const { core, mode } = buildSystemPrompt(session);
  const tools = toolsForSession(session);
  const messages: Anthropic.MessageParam[] = incoming.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

      try {
        for (let round = 0; round <= CHAT_MAX_TOOL_ROUNDS; round++) {
          const finalRound = round === CHAT_MAX_TOOL_ROUNDS;
          const claudeStream = anthropic.messages.stream({
            model: CLAUDE_MODEL,
            max_tokens: 16000,
            system: [
              // Stable core first with a cache breakpoint; volatile per-session
              // mode block after it so the cache prefix survives across users.
              { type: "text", text: core, cache_control: { type: "ephemeral" } },
              { type: "text", text: mode },
            ],
            tools: tools.map((t) => t.definition),
            // Last round: force a text answer so a tool-happy loop terminates.
            tool_choice: finalRound ? { type: "none" } : undefined,
            messages,
          });

          claudeStream.on("text", (delta) => send({ type: "text", text: delta }));
          const response = await claudeStream.finalMessage();

          if (response.stop_reason !== "tool_use") {
            send({ type: "done" });
            controller.close();
            return;
          }

          messages.push({ role: "assistant", content: response.content });
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            const tool = findTool(block.name, session);
            send({ type: "tool", name: block.name, label: tool?.label || block.name });
            let result: string;
            let isError = false;
            if (!tool) {
              result = "Tool not available in this mode.";
              isError = true;
            } else {
              try {
                result = await tool.execute(block.input as Record<string, unknown>, session);
              } catch (err) {
                result = `Tool failed: ${err instanceof Error ? err.message : "unknown error"}`;
                isError = true;
              }
            }
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: result,
              is_error: isError || undefined,
            });
          }
          messages.push({ role: "user", content: toolResults });
        }
      } catch (err) {
        console.error("chat stream failed:", err);
        send({
          type: "error",
          message: "Something went wrong while generating a response. Please try again.",
        });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
