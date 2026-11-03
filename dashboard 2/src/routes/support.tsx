import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Guard } from "@/components/route-guard";
import { SupportDesk } from "@/components/support-desk";
import { PageHead } from "@/components/workspace-shell";

export const Route = createFileRoute("/support")({
  head: () => ({
    meta: [
      { title: "Support — zAfAr" },
      { name: "description", content: "Message the zAfAr owner about any problem." },
      { property: "og:title", content: "Support — zAfAr" },
      { property: "og:description", content: "Message the zAfAr owner about any problem." },
    ],
  }),
  component: () => (
    <Guard>
      <div className="min-h-screen bg-canvas px-4 py-8">
        <div className="mx-auto max-w-3xl">
          <Link to="/dashboard" className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft size={14} />Back to my space</Link>
          <PageHead eyebrow="More" title="support" />
          <SupportDesk owner={false} />
        </div>
      </div>
    </Guard>
  ),
});
