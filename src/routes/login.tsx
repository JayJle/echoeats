import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function safeNext(next: string | undefined): string {
  if (!next) return "/";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export const Route = createFileRoute("/login")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    next: typeof s.next === "string" ? s.next : undefined,
  }),
  component: Login,
  head: () => ({
    meta: [
      { title: "登录 · Echo Eats" },
      { name: "description", content: "登录 Echo Eats，用于授权外部 AI 助手访问餐厅发现工具。" },
      { property: "og:title", content: "登录 · Echo Eats" },
      { property: "og:description", content: "登录 Echo Eats，用于授权外部 AI 助手访问餐厅发现工具。" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function Login() {
  const { next } = Route.useSearch();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const target = safeNext(next);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    window.location.href = target;
  }

  async function signUp() {
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}${target}` },
    });
    setBusy(false);
    setMsg(error ? error.message : "注册邮件已发送，请查收邮箱完成验证后再登录。");
  }

  async function google() {
    setMsg(null);
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: `${window.location.origin}${target}`,
    });
    if (result.error) {
      setMsg("Google 登录失败，请重试。");
      return;
    }
    if (result.redirected) return;
    navigate({ to: target as string });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-5 p-6">
      <h1 className="text-xl font-semibold">登录 Echo Eats</h1>
      <form onSubmit={signIn} className="space-y-3">
        <Input
          type="email"
          required
          placeholder="邮箱"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          type="password"
          required
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" className="w-full" disabled={busy || !email || !password}>
          登录
        </Button>
      </form>
      <div className="flex gap-3">
        <Button variant="outline" className="flex-1" onClick={google} disabled={busy}>
          使用 Google 登录
        </Button>
        <Button variant="ghost" className="flex-1" onClick={signUp} disabled={busy || !email || !password}>
          注册
        </Button>
      </div>
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </main>
  );
}
