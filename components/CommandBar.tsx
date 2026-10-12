"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { COMMAND_HINTS, parseCommand, type Command } from "@/lib/command";
import { todayIso } from "@/lib/format";

// The command line in the top bar: the one search in words. As the visitor types,
// lib/command.ts ranks what the words could mean (a trip to a place, getaways, events, a loop,
// a long stay, a place page, an itinerary, or a question for the chat, always last); the
// dropdown shows them, Up and Down move, Enter runs the highlighted one, Escape closes. With
// the box empty it shows examples. "/" or Ctrl+K focus it from anywhere on the page. The shell
// runs the command (onRun): every search kind becomes one SearchQuery that fills the search
// bar and runs, the same as an 'atlas:search' event; a place, a plan and a question do not.

// Keyed by plain strings, not Command["kind"]: the brain stream adds the 'walk' kind to
// lib/command.ts, and this file must build both before and after it lands.
const ICON: Record<string, string> = {
  walk: "⤳",
  route: "⇄",
  events: "✺",
  getaways: "✈",
  wild: "◌",
  longstay: "⌂",
  place: "◉",
  itinerary: "✦",
  ask: "?",
};
const WHAT: Record<string, string> = {
  walk: "search: a loop, city by city",
  route: "search: trips to this place",
  events: "search: trips with events on",
  getaways: "search: trips from your airports",
  wild: "search: a long loop",
  longstay: "search: a long stay",
  place: "a place page",
  itinerary: "a day by day plan",
  ask: "ask the chat",
};

/** A key press that belongs to a field the visitor is typing in, not to the page. */
function typingIn(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/**
 * Words that open a part of the app rather than run a search: "/help" (or "help", "?", "how
 * does atlas work") opens the guide, "/style" the trip style. Checked before the parser, which
 * would send them to the chat as a question.
 */
function appCommand(text: string): "help" | "style" | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^\/?(help|guide|\?|how does (atlas|this|it) work\??|how to use( atlas)?)$/.test(t)) return "help";
  if (/^\/?(style|trip style|prefs|preferences|settings)$/.test(t)) return "style";
  return null;
}

export default function CommandBar({ onRun, busy, onHelp }: { onRun: (c: Command) => void; busy?: boolean; /** Opens "How Atlas works". */ onHelp?: () => void }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLFormElement>(null);
  const special = appCommand(text);
  // Parsing is pure and cheap (no network): every keystroke re-ranks. Today is the visitor's own calendar day.
  const suggestions = useMemo(() => (text.trim() && !appCommand(text) ? parseCommand(text, todayIso()) : []), [text]);
  useEffect(() => setHi(0), [text]);

  // "/" and Ctrl+K (Cmd+K on a Mac) focus the box from anywhere, except while typing elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "k") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
        setOpen(true);
        return;
      }
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !typingIn(e.target)) {
        e.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // A click outside closes the list; the box keeps what was typed.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);

  const runSpecial = (what: "help" | "style") => {
    if (what === "help") onHelp?.();
    else window.dispatchEvent(new CustomEvent("atlas:open-prefs"));
    setText("");
    setOpen(false);
    input.current?.blur();
  };
  const run = (c: Command | undefined) => {
    if (!c) return;
    onRun(c);
    setText("");
    setOpen(false);
    input.current?.blur();
  };
  const showHints = open && !text.trim();
  const showList = open && suggestions.length > 0;

  return (
    <form
      ref={box}
      className={`askbar cmdbar${open ? " open" : ""}`}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (special) runSpecial(special);
        else run(suggestions[hi] ?? suggestions[0]);
      }}
    >
      <span className="cmdicon" aria-hidden="true">
        {busy ? <span className="cmdspin" /> : "⌘"}
      </span>
      <input
        ref={input}
        value={text}
        placeholder="Lisbon in november, getaways this weekend, or ask anything"
        aria-label="Search in words: a place, dates, a loop, or a question"
        aria-expanded={showList || showHints}
        aria-controls="cmdlist"
        aria-autocomplete="list"
        role="combobox"
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHi((h) => Math.min(h + 1, Math.max(0, (suggestions.length || COMMAND_HINTS.length) - 1)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(0, h - 1));
          } else if (e.key === "Escape") {
            e.preventDefault();
            if (open) setOpen(false);
            else input.current?.blur();
          } else if (e.key === "Enter" && !text.trim() && showHints) {
            // Enter on an empty box takes the highlighted example, ready to edit.
            e.preventDefault();
            setText(COMMAND_HINTS[hi]?.example ?? "");
          }
        }}
      />
      <kbd className="cmdkbd" aria-hidden="true">
        /
      </kbd>
      <button type="submit" disabled={!suggestions.length && !special}>
        Go
      </button>
      {open && special && (
        <div className="cmdlist" id="cmdlist" role="listbox">
          <button type="button" role="option" aria-selected className="cmdopt on" onMouseDown={(e) => e.preventDefault()} onClick={() => runSpecial(special)}>
            <span className="cmdglyph" aria-hidden="true">
              {special === "help" ? "?" : "≡"}
            </span>
            <span className="cmdlabel">{special === "help" ? "How Atlas works" : "Your trip style"}</span>
            <span className="cmdwhat">{special === "help" ? "every feature, with one thing to try" : "nights a place, pace, what to avoid"}</span>
          </button>
        </div>
      )}
      {showList && (
        <div className="cmdlist" id="cmdlist" role="listbox">
          {suggestions.map((c, i) => (
            <button
              key={`${c.kind}-${i}`}
              type="button"
              role="option"
              aria-selected={i === hi}
              className={`cmdopt${i === hi ? " on" : ""}${c.kind === "ask" ? " ask" : ""}`}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(c)}
            >
              <span className="cmdglyph" aria-hidden="true">
                {ICON[c.kind] ?? "›"}
              </span>
              <span className="cmdlabel">{c.label}</span>
              <span className="cmdwhat">{WHAT[c.kind] ?? ""}</span>
            </button>
          ))}
          <div className="cmdfoot">
            <span>↑ ↓ to choose</span>
            <span>Enter to run</span>
            <span>Esc to close</span>
          </div>
        </div>
      )}
      {showHints && (
        <div className="cmdlist" id="cmdlist" role="listbox">
          <div className="cmdhead">Type a search in your own words, or a question. For example:</div>
          {COMMAND_HINTS.map((h, i) => (
            <button
              key={h.example}
              type="button"
              role="option"
              aria-selected={i === hi}
              className={`cmdopt hint${i === hi ? " on" : ""}`}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setText(h.example);
                input.current?.focus();
              }}
            >
              <span className="cmdlabel mono">{h.example}</span>
              <span className="cmdwhat">{h.what}</span>
            </button>
          ))}
          <div className="cmdfoot">
            <span>/ or Ctrl+K from anywhere</span>
          </div>
        </div>
      )}
    </form>
  );
}
