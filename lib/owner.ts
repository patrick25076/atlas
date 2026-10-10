// Client-safe. The browser's owner id: a random string this browser keeps so the itineraries
// it saves can be listed and deleted again without an account. It is not a secret and not a
// login, just a key; anyone holding a share link can read an itinerary, only the browser that
// saved it can delete it. Kept in localStorage under one key, created on first use.
//
// Storage can be off (a private window, blocked site data, a preview frame): every access is
// wrapped, and when it fails the id lives in memory for this page load, so saving still works
// once; it simply cannot be listed after a reload.

const KEY = "atlas-owner-v1";
/** The header the itinerary routes read the owner from. */
export const OWNER_HEADER = "x-atlas-owner";

let memoryId: string | null = null;

function newId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // randomUUID needs a secure context (https or localhost); fall through to the manual id.
  }
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function read(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const v = localStorage.getItem(KEY);
    return v && /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** True when this browser lets the page keep data (so saved trips can be listed later). */
export function storageWorks(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    const probe = `${KEY}-probe`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** The stored owner id, or null when none was ever made or storage is off. Never creates one. */
export function existingOwnerId(): string | null {
  return read();
}

/** The owner id, created and stored on first use; an in-memory id when storage is off. */
export function ownerId(): string {
  const stored = read();
  if (stored) return stored;
  const id = memoryId ?? newId();
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Storage is off: keep the id for this page load only.
  }
  memoryId = id;
  return id;
}

/** Headers carrying the owner id, for the save, list and delete calls. */
export function ownerHeaders(create = true): Record<string, string> {
  const id = create ? ownerId() : existingOwnerId();
  return id ? { [OWNER_HEADER]: id } : {};
}
