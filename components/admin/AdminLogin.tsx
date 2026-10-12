"use client";

import { useState } from "react";
import s from "./admin.module.css";

// The owner's key, once per browser: it opens the engine room for 90 days.
export default function AdminLogin() {
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
      if (r.ok) location.reload();
      else setErr(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s.page}>
      <form onSubmit={go} className={s.card} style={{ maxWidth: 420, margin: "18vh auto 0", display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Engine room</h2>
        <p className={s.muted} style={{ margin: 0 }}>
          The owner&apos;s key (ATLAS_ADMIN_KEY in .env.local). Once per browser, for 90 days.
        </p>
        <label className={s.field}>
          Key
          <input type="password" autoComplete="current-password" value={key} onChange={(e) => setKey(e.target.value)} autoFocus style={{ width: "100%", fontSize: 16 }} />
        </label>
        <button className={s.go} disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Open"}
        </button>
        {err && <p className={s.warn}>{err}</p>}
      </form>
    </div>
  );
}
