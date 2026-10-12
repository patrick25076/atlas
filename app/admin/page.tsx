import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ADMIN_COOKIE, adminExists, adminFromCookieHeader } from "@/lib/admin";
import EngineRoom from "@/components/admin/EngineRoom";
import AdminLogin from "@/components/admin/AdminLogin";

// The engine room: how Atlas thinks, for the owner (lib/admin.ts). Open under the dev server; on the live site it
// asks for the owner's key once per browser, and does not exist at all where no key is set.
export const metadata: Metadata = { title: "Engine room · Atlas", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!adminExists()) notFound();
  const jar = await cookies();
  const value = jar.get(ADMIN_COOKIE)?.value;
  if (!adminFromCookieHeader(value ? `${ADMIN_COOKIE}=${value}` : null)) return <AdminLogin />;
  return <EngineRoom />;
}
