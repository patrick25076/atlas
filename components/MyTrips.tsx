"use client";

import { useCallback, useEffect, useState } from "react";
import type { Itinerary } from "@/lib/itinerary";
import type { SavedItinerary } from "./Itinerary";
import { euro, kiwiPhoto, shortDate } from "@/lib/format";
import { existingOwnerId, OWNER_HEADER } from "@/lib/owner";
import s from "./Itinerary.module.css";

// The itineraries this browser saved, as a strip of covers. The browser is known only by its
// owner id (lib/owner.ts); no id yet, or storage switched off, means nothing was ever saved
// here, so the strip renders nothing and asks the server nothing. It refreshes itself when the
// itinerary view saves a new one (the 'atlas:itinerary-saved' window event).

type Item = { id: string; title: string; start: string; nights: number; total: number; img?: string; savedAt: string };

/** "one way", "1 night", "4 nights": the same wording as the itinerary's own stats. */
function nightsLabel(n: number): string {
  return n <= 0 ? "one way" : `${n} ${n === 1 ? "night" : "nights"}`;
}

function coverOf(img?: string): string | null {
  if (!img) return null;
  return /^https?:\/\//.test(img) ? img : kiwiPhoto(img);
}

export default function MyTrips({ onOpen }: { onOpen: (it: Itinerary) => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    const owner = existingOwnerId();
    if (!owner) return setItems([]);
    try {
      const res = await fetch("/api/itinerary", { headers: { [OWNER_HEADER]: owner }, cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { items?: Item[] };
      setItems(Array.isArray(j.items) ? j.items : []);
    } catch {
      // Offline or the route is missing: keep whatever the strip showed.
    }
  }, []);

  useEffect(() => {
    load();
    const again = () => load();
    window.addEventListener("atlas:itinerary-saved", again);
    return () => window.removeEventListener("atlas:itinerary-saved", again);
  }, [load]);

  const open = async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/itinerary/${encodeURIComponent(id)}`);
      // The stored plan's own id is its plan key, not the share id; attaching the id it was
      // opened under lets the view show it as saved instead of saving a second copy.
      if (res.ok) onOpen({ ...((await res.json()) as Itinerary), savedId: id } as SavedItinerary);
    } catch {
      /* the card stays; a second tap tries again */
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    // Two taps: the first arms the button, the second deletes, so a stray tap loses nothing.
    if (confirm !== id) {
      setConfirm(id);
      setTimeout(() => setConfirm((c) => (c === id ? null : c)), 3000);
      return;
    }
    const owner = existingOwnerId();
    if (!owner) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/itinerary/${encodeURIComponent(id)}`, { method: "DELETE", headers: { [OWNER_HEADER]: owner } });
      if (res.ok || res.status === 404) setItems((xs) => xs.filter((x) => x.id !== id));
    } catch {
      /* left in place */
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  if (!items.length) return null;
  return (
    <section className={s.myTrips} aria-label="Your saved trips">
      <div className={s.myHead}>
        <span>Your trips</span>
        <small>{items.length}</small>
      </div>
      <div className={s.myStrip} role="list">
        {items.map((it) => {
          const cover = coverOf(it.img);
          return (
            <div key={it.id} className={s.myCard} role="listitem" data-busy={busy === it.id ? "1" : "0"}>
              <button type="button" className={s.myOpen} onClick={() => open(it.id)} title={`Open ${it.title}`}>
                <span className={`${s.photo} ${s.myCover}`}>{cover && <img src={cover} alt="" loading="lazy" />}</span>
                <span className={s.myText}>
                  <b>{it.title}</b>
                  <small>
                    {shortDate(it.start)} · {nightsLabel(it.nights)}
                  </small>
                  {it.total > 0 && <em>{euro(it.total)}</em>}
                </span>
              </button>
              <button type="button" className={s.myDelete} data-armed={confirm === it.id ? "1" : "0"} onClick={() => remove(it.id)} aria-label={confirm === it.id ? `Really delete ${it.title}` : `Delete ${it.title}`}>
                {confirm === it.id ? "Delete?" : "×"}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
