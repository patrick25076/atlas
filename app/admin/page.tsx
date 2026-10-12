import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { adminAllowed } from "@/lib/admin";
import EngineRoom from "@/components/admin/EngineRoom";

// The engine room: how Atlas thinks, for the owner on his own machine (lib/admin.ts). In production it does not exist
// unless ATLAS_ADMIN=1 is set on purpose.
export const metadata: Metadata = { title: "Engine room · Atlas", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function AdminPage() {
  if (!adminAllowed()) notFound();
  return <EngineRoom />;
}
