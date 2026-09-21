"use client";

import { useEffect, useRef, useState } from "react";
import { INTEREST_FORM_URL } from "@/lib/config";
import { STUDENT_PATH } from "@/lib/studentPath";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  tools?: string[]; // labels of tools run while producing this message
}

type MemberState =
  | { status: "loading" }
  | { status: "public" }
  | { status: "member"; name?: string; school?: string };

const PUBLIC_STARTERS = [
  "What is this site? Give me the quick tour.",
  "Show me examples of AI being used for climate and the environment.",
  "Which of these projects are actually up and running, not just ideas?",
  "I know an AI project doing public good — how do I get it added here?",
];

const MEMBER_STARTERS = [
  "I have an idea for a new entry — help me figure out if it's worth writing up.",
  "What does writing a research memo involve, start to finish?",
  "I have a draft going — how do I get your feedback on it?",
  "How does my memo get reviewed and published?",
];

/** Minimal, safe markdown-ish rendering: escape HTML, then bold/links/lists. */
function renderMarkdown(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const withInline = escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )
    .replace(
      /(^|\s)(https?:\/\/[^\s<]+[^\s<.,)])/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>',
    );

  const lines = withInline.split("\n");
  const html: string[] = [];
  let list: "ul" | "ol" | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${paragraph.join("<br/>")}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const bullet = trimmed.match(/^[-*]\s+(.*)/);
    const numbered = trimmed.match(/^\d+[.)]\s+(.*)/);
    if (bullet || numbered) {
      flushParagraph();
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        html.push(`<${kind}>`);
        list = kind;
      }
      html.push(`<li>${(bullet || numbered)![1]}</li>`);
    } else if (!trimmed) {
      flushParagraph();
      closeList();
    } else {
      closeList();
      paragraph.push(trimmed);
    }
  }
  flushParagraph();
  closeList();
  return html.join("");
}

export function Assistant() {
  const [member, setMember] = useState<MemberState>({ status: "loading" });
  const [email, setEmail] = useState("");
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/verify")
      .then((r) => r.json())
      .then((d) => setMember(d.member ? { status: "member", name: d.name, school: d.school } : { status: "public" }))
      .catch(() => setMember({ status: "public" }));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, activeTool]);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setVerifying(true);
    setVerifyMessage(null);
            setMember({ status: "member", name: "AN", school: "UT Law" });

    // try {
    //   const res = await fetch("/api/verify", {
    //     method: "POST",
    //     headers: { "Content-Type": "application/json" },
    //     body: JSON.stringify({ email }),
    //   });
    //   const data = await res.json();
    //   if (data.member) {
    //     setMember({ status: "member", name: data.name, school: data.school });
    //     setVerifyMessage(null);
    //   } else if (res.ok) {
    //     setVerifyMessage("notfound");
    //   } else {
    //     setVerifyMessage(data.error || "Verification failed. Please try again.");
    //   }
    // } catch {
    //   setVerifyMessage("Verification failed. Please try again.");
    // } finally {
    //   setVerifying(false);
    // }
  }

  async function signOut() {
    await fetch("/api/verify", { method: "DELETE" });
    setMember({ status: "public" });
    setMessages([]);
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    setInput("");
    setBusy(true);
    setActiveTool(null);

    const history = [...messages, { role: "user" as const, content }];
    setMessages([...history, { role: "assistant", content: "", tools: [] }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map(({ role, content }) => ({ role, content })),
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "The assistant is unavailable right now.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";
      const toolLabels: string[] = [];

      const apply = () =>
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: "assistant", content: assistantText, tools: [...toolLabels] };
          return next;
        });

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === "text") {
            assistantText += event.text;
            setActiveTool(null);
            apply();
          } else if (event.type === "tool") {
            if (!toolLabels.includes(event.label)) toolLabels.push(event.label);
            setActiveTool(event.label);
            apply();
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }
      }
      if (!assistantText.trim()) {
        assistantText = "I wasn't able to produce a response — please try again.";
        apply();
      }
    } catch (err) {
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          content: err instanceof Error ? err.message : "Something went wrong. Please try again.",
        };
        return next;
      });
    } finally {
      setBusy(false);
      setActiveTool(null);
    }
  }

  const starters = member.status === "member" ? MEMBER_STARTERS : PUBLIC_STARTERS;

  return (
    <div className="flex flex-1 flex-col">
      {/* Heading + membership panel */}
      <div className="border-b border-rule-strong pb-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="label mb-2 text-accent">The Research Assistant</p>
            <h1 className="font-serif text-3xl tracking-tight sm:text-4xl">
              {member.status === "member" ? (
                <>Welcome back{member.name ? `, ${member.name.split(" ")[0]}` : ""}.</>
              ) : (
                <>Ask me anything about AI for the public good.</>
              )}
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-soft">
              {member.status === "member" ? (
                <>
                  Tell me your idea and I&apos;ll help you turn it into a published
                  research memo — or pick up wherever you left off.
                </>
              ) : (
                <>
                  This site collects real examples of AI tackling public problems —
                  in courts, classrooms, elections, disaster response, and more.
                  I&apos;m the guide: ask what&apos;s in the collection, dig into any
                  entry, or find out how to contribute one of your own.
                </>
              )}
            </p>
          </div>
          {member.status === "member" ? (
            <div className="text-right">
              <p className="label text-moss">● Member workflow unlocked</p>
              {member.school ? <p className="mt-1 text-xs text-ink-faint">{member.school}</p> : null}
              <button onClick={signOut} className="label mt-1 text-ink-faint underline underline-offset-2 hover:text-accent">
                Sign out
              </button>
            </div>
          ) : null}
        </div>

        {member.status === "public" ? (
          <div className="mt-5 border border-rule bg-paper-sunken p-4">
            <p className="text-sm text-ink-soft">
              <span className="font-medium text-ink">Part of the research community?</span>{" "}
              Students and researchers in the program can do more than browse: I&apos;ll
              help you check whether your idea is already covered, develop it into a
              short research memo, and send the finished draft to the human editors.
              Enter the email you signed up with to switch that on.
            </p>
            <form onSubmit={verify} className="mt-3 flex flex-wrap gap-2">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@school.edu"
                className="min-w-56 flex-1 border border-rule bg-paper-raised px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
              />
              <button
                type="submit"
                disabled={verifying}
                className="label border border-rule-strong bg-ink px-4 py-2.5 text-paper transition-colors hover:bg-accent-deep disabled:opacity-50"
              >
                {verifying ? "Checking…" : "Verify"}
              </button>
            </form>
            {verifyMessage === "notfound" ? (
              <p className="mt-2.5 text-sm text-ink-soft">
                That email isn&apos;t on the community roster yet.{" "}
                <a href={INTEREST_FORM_URL} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">
                  Fill out the interest form
                </a>{" "}
                to join, then verify here once you&apos;re added.
              </p>
            ) : verifyMessage ? (
              <p className="mt-2.5 text-sm text-accent-deep">{verifyMessage}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Conversation */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-6" aria-live="polite">
        {messages.length === 0 ? (
          <div>
            {member.status === "public" ? (
              <div className="mb-8">
                <p className="label mb-4 text-ink-faint">
                  For student researchers — have an idea? Here&apos;s the path.
                </p>
                <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {STUDENT_PATH.map((step) => (
                    <li key={step.n} className="border-t-2 border-rule-strong pt-3">
                      <p className="font-serif text-lg text-accent">{step.n}</p>
                      <h3 className="mt-1 font-serif text-base tracking-tight">{step.title}</h3>
                      <p className="mt-1.5 text-xs leading-relaxed text-ink-soft">{step.body}</p>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            <p className="label mb-4 text-ink-faint">Try asking</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {starters.map((starter) => (
                <button
                  key={starter}
                  onClick={() => send(starter)}
                  className="border border-rule bg-paper-raised p-4 text-left text-sm leading-snug text-ink-soft transition-all hover:border-accent hover:text-ink hover:shadow-[3px_3px_0_0_var(--accent-wash)]"
                >
                  {starter}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {messages.map((message, i) => (
              <div key={i}>
                {message.role === "user" ? (
                  <div className="ml-auto max-w-[85%] w-fit border border-rule bg-accent-wash px-4 py-3 text-sm leading-relaxed">
                    {message.content}
                  </div>
                ) : (
                  <div className="max-w-[95%]">
                    {message.tools && message.tools.length > 0 ? (
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        {message.tools.map((label) => (
                          <span key={label} className="label border border-rule bg-paper-sunken px-2 py-1 text-ink-faint">
                            ⚙ {label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {message.content ? (
                      <div
                        className="chat-prose text-[0.95rem] leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                      />
                    ) : i === messages.length - 1 && busy ? (
                      <p className="text-sm text-ink-faint">
                        {activeTool ? `${activeTool}…` : "Thinking"}
                        <span className="cursor-blink">▍</span>
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="sticky bottom-0 border-t border-rule-strong bg-paper pb-4 pt-3"
      >
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={2}
            placeholder={
              member.status === "member"
                ? "Tell me your idea, paste a draft, or ask anything…"
                : "Ask about any project here, or how to get involved…"
            }
            className="flex-1 resize-none border border-rule bg-paper-raised px-3.5 py-3 text-sm leading-relaxed outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="label border border-rule-strong bg-ink px-4 py-3.5 text-paper transition-colors hover:bg-accent-deep disabled:opacity-40"
          >
            Send
          </button>
        </div>
        <p className="mt-2 text-[0.7rem] text-ink-faint">
          AI-generated responses — not legal advice. The assistant coaches research;
          it does not write memos.
        </p>
      </form>
    </div>
  );
}
