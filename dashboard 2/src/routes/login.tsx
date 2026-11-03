import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { AuthScreen } from "@/components/auth-screen";
import { homeFor, useSession } from "@/lib/session";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in — zAfAr" },
      { name: "description", content: "Sign in or create your zAfAr account." },
      { property: "og:title", content: "Sign in — zAfAr" },
      { property: "og:description", content: "Sign in or create your zAfAr account." },
    ],
  }),
  component: Login,
});

function Login() {
  const { session, ready } = useSession();
  const navigate = useNavigate();
  useEffect(() => { if (ready && session) navigate({ to: homeFor(session), replace: true }); }, [ready, session]);
  return <AuthScreen />;
}
