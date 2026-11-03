import { createFileRoute } from "@tanstack/react-router";
import { Guard } from "@/components/route-guard";
import { MemberConnection } from "@/components/member-connection";
import { MemberWorkspace } from "@/components/member-workspace";
import { MemberPortal } from "@/components/member-portal";
import { useSession } from "@/lib/session";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "My Workspace — zAfAr" },
      { name: "description", content: "Link your WhatsApp number and use your zAfAr commands." },
      { property: "og:title", content: "My Workspace — zAfAr" },
      { property: "og:description", content: "Link your WhatsApp number and use your zAfAr commands." },
    ],
  }),
  component: () => <Guard><Dashboard /></Guard>,
});

function Dashboard() {
  const { session } = useSession();
  if (session!.role === "owner") return <MemberPortal />;
  return session!.linked ? <MemberWorkspace /> : <MemberConnection />;
}
