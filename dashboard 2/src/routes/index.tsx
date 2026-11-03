import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { homeFor, useSession } from "@/lib/session";
import { Loading } from "@/components/route-guard";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "zAfAr — Your WhatsApp companion" },
      { name: "description", content: "zAfAr connects your WhatsApp to commands, media tools and Scribd." },
      { property: "og:title", content: "zAfAr — Your WhatsApp companion" },
      { property: "og:description", content: "zAfAr connects your WhatsApp to commands, media tools and Scribd." },
    ],
  }),
  component: Entry,
});

function Entry() {
  const { session, ready } = useSession();
  const navigate = useNavigate();
  useEffect(() => { if (ready) navigate({ to: homeFor(session), replace: true }); }, [ready, session]);
  return <Loading />;
}
