import { createFileRoute } from "@tanstack/react-router";
import { AdminConsole } from "@/components/admin-console";
import { Guard } from "@/components/route-guard";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Control Room — zAfAr" },
      { name: "description", content: "Owner console for WhatsApp numbers, Scribd, members and activity." },
      { property: "og:title", content: "Control Room — zAfAr" },
      { property: "og:description", content: "Owner console for WhatsApp numbers, Scribd, members and activity." },
    ],
  }),
  component: () => <Guard role="owner"><AdminConsole /></Guard>,
});
