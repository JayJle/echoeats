import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { supabaseOAuth } from "@/lib/supabase-oauth";

export const Route = createFileRoute("/.lovable/oauth/consent")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    authorization_id: typeof s.authorization_id === "string" ? s.authorization_id : "",
  }),
  beforeLoad: async ({ search, location }) => {
    if (!search.authorization_id) throw new Error("Missing authorization_id");
    const { data } = await supabase.auth.getSession();
    const next = location.pathname + location.searchStr;
    if (!data.session) throw redirect({ to: "/login", search: { next } });
  },
  loader: async ({ location }) => {
    const authorizationId = new URLSearchParams(location.search).get("authorization_id")!;
    const { data, error } = await supabaseOAuth().getAuthorizationDetails(authorizationId);
    if (error) throw error;
    const immediate = data?.redirect_url ?? data?.redirect_to;
    if (immediate && !data?.client) throw redirect({ href: immediate });
    return data;
  },
  component: Consent,
  errorComponent: ({ error }) => (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 p-6">
      <h1 className="text-lg font-semibold">无法加载授权请求</h1>
      <p className="text-sm text-muted-foreground">{String((error as Error)?.message ?? error)}</p>
    </main>
  ),
  head: () => ({
    meta: [
      { title: "授权连接 · Echo Eats" },
      { name: "description", content: "允许外部 AI 助手以你的身份使用 Echo Eats 的餐厅发现工具。" },
      { property: "og:title", content: "授权连接 · Echo Eats" },
      { property: "og:description", content: "允许外部 AI 助手以你的身份使用 Echo Eats 的餐厅发现工具。" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function Consent() {
  const details = Route.useLoaderData();
  const { authorization_id } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientName = details?.client?.name ?? "该应用";

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const { data, error: err } = approve
      ? await supabaseOAuth().approveAuthorization(authorization_id)
      : await supabaseOAuth().denyAuthorization(authorization_id);
    if (err) {
      setBusy(false);
      setError(err.message);
      return;
    }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) {
      setBusy(false);
      setError("授权服务器未返回跳转地址。");
      return;
    }
    window.location.href = target;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">把 Echo Eats 连接到 {clientName}</h1>
        <p className="text-sm text-muted-foreground">
          同意后，{clientName} 可以以你的身份调用 Echo Eats 的餐厅发现工具（城市识别、餐厅检索）。
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <Button disabled={busy} onClick={() => decide(true)} className="flex-1">
          同意授权
        </Button>
        <Button disabled={busy} variant="outline" onClick={() => decide(false)} className="flex-1">
          拒绝
        </Button>
      </div>
    </main>
  );
}
