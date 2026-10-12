// The engine room (app/admin, app/api/admin/*) is the owner's own view of how Atlas decides: the walk's every
// candidate, the beam, the price graph's coverage and the fares behind a hop. It runs on the owner's machine
// (`pnpm dev`), and in production only when ATLAS_ADMIN=1 is set on purpose: the traces name every price and every
// rule, which is nobody else's business, and a traced walk can spend live searches.

/** True where the engine room may open: development, or a deployment that set ATLAS_ADMIN=1. */
export function adminAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ATLAS_ADMIN?.trim() === "1";
}

/** The answer when it may not: a plain 404, so the route does not even say it exists. */
export function adminRefused(): Response {
  return new Response("Not found", { status: 404 });
}
