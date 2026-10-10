"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import type { Deal } from "@/lib/types";
import type { WildTrip } from "@/lib/wild";
import { countryName, dateRange } from "@/lib/format";
import { formatDuration } from "@/lib/geo";

export type ChatContext = { origin?: { lat: number; lon: number; label: string }; gateways: string[]; home: string; month?: string };

type Props = {
  context: ChatContext;
  seed: string | null;
  onSeedConsumed: () => void;
  onDeals: (deals: Deal[]) => void;
  onTrip: (trip: WildTrip) => void;
  onOpenDeal: (key: string) => void;
};

const STORE = "atlas-chat-v1";
const TOOL_LABEL: Record<string, string> = {
  home_airports: "Looking at your airports",
  cheapest_deals: "Reading tonight's prices",
  find_getaways: "Searching live for your dates",
  reprice_route: "Pricing the route live",
  two_city_combos: "Checking two-city combos",
  wild_trip: "Building the loop (a minute or two)",
  plan_days: "Planning the days",
  sights: "Reading the guide",
  events_near: "Checking what's on",
  eats_near: "Checking rated restaurants",
  hotels_near: "Checking hotel prices",
  oneway_fares: "Reading one-way fares",
  ground_reach: "Checking trains and coaches",
  place_facts: "Looking up the facts",
  web_search: "Searching the web",
};
const STARTERS = ["A 3 to 6 night getaway to a cool autumn place between 20 and 30 October", "Where is warm and cheap for a weekend?", "Plan me two weeks in Southeast Asia, true experiences, mid budget", "Best traditional food in Lisbon without tourist prices", "Which of my airports is worth the drive?"];

type ToolPart = { type: string; toolCallId?: string; state?: string; input?: unknown; output?: unknown; errorText?: string };

function loadStored(): UIMessage[] {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return [];
    const j = JSON.parse(raw) as { messages?: UIMessage[] };
    return Array.isArray(j.messages) ? j.messages.slice(-30) : [];
  } catch {
    return [];
  }
}

/** Light markdown: paragraphs, **bold**, [links](url) and bare urls. */
function Text({ text }: { text: string }) {
  const paras = text.split(/\n{2,}/);
  const render = (s: string) =>
    s.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s)]+)/).map((bit, k) => {
      if (bit.startsWith("**") && bit.endsWith("**")) return <b key={k}>{bit.slice(2, -2)}</b>;
      const link = bit.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (link)
        return (
          <a key={k} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        );
      if (/^https?:\/\//.test(bit))
        return (
          <a key={k} href={bit} target="_blank" rel="noreferrer">
            {bit.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}
          </a>
        );
      return <span key={k}>{bit}</span>;
    });
  return (
    <>
      {paras.map((para, i) => (
        <p key={i}>{render(para.replace(/\n/g, " "))}</p>
      ))}
    </>
  );
}

export default function ChatPanel(p: Props) {
  const [initial] = useState<UIMessage[]>(() => (typeof window === "undefined" ? [] : loadStored()));
  const contextRef = useRef(p.context);
  contextRef.current = p.context;
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat", prepareSendMessagesRequest: ({ messages }) => ({ body: { messages, context: contextRef.current } }) }), []);
  const { messages, sendMessage, status, stop, setMessages, error } = useChat({ transport, messages: initial });
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const applied = useRef(new Set<string>());
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify({ messages: messages.slice(-30) }));
    } catch {
      // storage off
    }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // A question typed in the top bar lands here.
  useEffect(() => {
    if (p.seed && !busy) {
      sendMessage({ text: p.seed });
      p.onSeedConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.seed]);

  // Results flow to the globe: deals as pins and cards, a trip as a route.
  useEffect(() => {
    for (const m of messages) {
      for (const part of m.parts as ToolPart[]) {
        if (!part.type.startsWith("tool-") || part.state !== "output-available" || !part.toolCallId || applied.current.has(part.toolCallId)) continue;
        const out = part.output as { raw?: unknown } | undefined;
        if ((part.type === "tool-find_getaways" || part.type === "tool-cheapest_deals") && Array.isArray(out?.raw)) {
          applied.current.add(part.toolCallId);
          p.onDeals(out!.raw as Deal[]);
        }
        if (part.type === "tool-wild_trip" && out?.raw && typeof out.raw === "object") {
          applied.current.add(part.toolCallId);
          p.onTrip(out.raw as WildTrip);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    sendMessage({ text: t });
    setDraft("");
  };

  return (
    <div className="chat">
      <div ref={listRef} className="msgs">
        {messages.length === 0 && (
          <div className="chatintro">
            <p>Tell me what you are after and I will search the real prices, the guides and the web, then keep refining with you. I know where you are and your airports.</p>
            <div className="chips">
              {STARTERS.map((s) => (
                <button key={s} className="chip ghost" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role === "user" ? "user" : "ai"}`}>
            {m.parts.map((part, i) => {
              if (part.type === "text") return <Text key={i} text={part.text} />;
              const tp = part as ToolPart;
              if (!tp.type.startsWith("tool-")) return null;
              const name = tp.type.slice(5);
              const label = TOOL_LABEL[name] ?? name;
              const out = tp.output as { raw?: Deal[]; error?: string; deals?: unknown[]; found?: number } | undefined;
              return (
                <div key={i} className="toolwrap">
                  <div className={`toolchip ${tp.state === "output-available" ? "done" : tp.state === "output-error" ? "err" : "busy"}`}>
                    {tp.state === "output-available" ? "✓" : tp.state === "output-error" ? "!" : <span className="dot busy" />} {label}
                    {tp.state === "output-available" && out?.found != null ? `: ${out.found} found` : ""}
                    {tp.state === "output-error" ? `: ${tp.errorText ?? "failed"}` : ""}
                  </div>
                  {tp.state === "output-available" && Array.isArray(out?.raw) && out!.raw.length > 0 && (
                    <div className="chatcards">
                      {out!.raw.slice(0, 6).map((d) => (
                        <button key={`${d.gw}|${d.dst}|${d.out}`} className="chatcard" onClick={() => p.onOpenDeal(`${d.gw}|${d.dst}|${d.out}`)}>
                          <span className="price">€{d.price}</span>
                          <span className="chatcardbody">
                            <b>
                              {d.city} <span className="sub">{countryName(d.country)}</span>
                            </b>
                            <span className="sub">
                              {dateRange(d.out, d.back)} · {d.nights}n · {d.gw}
                              {d.backTo ? ` → ${d.backTo}` : ""} · {d.stops ? `${d.stops} stop` : "direct"} · {formatDuration(d.outMin)}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {!busy && messages.length > 0 && messages.at(-1)?.role === "assistant" && (
          <div className="chips followups">
            {["Direct flights only", "Try my other airports too", "Two-city version", "What do I eat there?", "Hotels for those dates", "Make it a week longer"].map((f) => (
              <button key={f} className="chip ghost" onClick={() => send(f)}>
                {f}
              </button>
            ))}
          </div>
        )}
        {busy && messages.at(-1)?.role === "user" && (
          <div className="bubble ai">
            <p className="muted">Thinking…</p>
          </div>
        )}
        {error && <div className="bubble ai err">The chat failed: {error.message}. Try again.</div>}
      </div>
      <form
        className="chatinput"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <input className="search" placeholder={busy ? "Searching…" : "Ask or refine: 'make it direct', 'from Cluj too', 'what do I eat there'"} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy && false} />
        {busy ? (
          <button type="button" className="chip" onClick={() => stop()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="chip on" disabled={!draft.trim()}>
            Send
          </button>
        )}
        {messages.length > 0 && !busy && (
          <button
            type="button"
            className="chip ghost"
            title="Start a new conversation"
            onClick={() => {
              setMessages([]);
              applied.current.clear();
              try {
                localStorage.removeItem(STORE);
              } catch {
                // storage off
              }
            }}
          >
            New
          </button>
        )}
      </form>
    </div>
  );
}
