import type { Metadata } from "next";
import { safeNext } from "@/lib/access";

// The access gate's page: one field, one button. A plain HTML form posting to /api/access,
// so it works before any JavaScript loads; the route sets the cookie and sends the visitor
// back to the page they came from (`next`, same-origin paths only).

export const metadata: Metadata = {
  title: "Atlas",
  robots: { index: false, follow: false },
};

const ERRORS: Record<string, string> = {
  wrong: "That code is not right. Try again.",
  slow: "Too many tries. Wait a minute, then try again.",
};

export default async function AccessPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const next = safeNext(one(sp.next));
  const error = ERRORS[one(sp.e) ?? ""];

  return (
    <main style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", padding: 16, background: "radial-gradient(ellipse at 50% 30%, #0d1426 0%, var(--bg) 70%)" }}>
      <form
        method="post"
        action="/api/access"
        style={{ width: "100%", maxWidth: 380, padding: "28px 24px", borderRadius: "var(--radius)", background: "var(--glass-2)", border: "1px solid var(--line-2)", boxShadow: "var(--shadow)", display: "grid", gap: 14 }}
      >
        <div style={{ fontSize: 13, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--mint)" }}>Atlas</div>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, lineHeight: 1.35 }}>Atlas is private for now. Enter the access code.</h1>
        <input type="hidden" name="next" value={next} />
        <input
          name="code"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          maxLength={200}
          aria-label="Access code"
          placeholder="Access code"
          style={{ font: "inherit", fontSize: 16, padding: "12px 14px", borderRadius: "var(--radius-s)", border: `1px solid ${error ? "var(--rose)" : "var(--line-2)"}`, background: "rgba(255,255,255,0.04)", color: "var(--ink)", outline: "none" }}
        />
        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 14, color: "var(--rose)" }}>
            {error}
          </p>
        )}
        <button type="submit" style={{ font: "inherit", fontSize: 15, fontWeight: 600, padding: "12px 14px", borderRadius: "var(--radius-s)", border: 0, background: "var(--mint)", color: "var(--mint-ink)", cursor: "pointer" }}>
          Open Atlas
        </button>
      </form>
    </main>
  );
}
