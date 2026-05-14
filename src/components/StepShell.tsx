import { Link } from "@tanstack/react-router";
import { ReactNode } from "react";

type Props = {
  step: number;
  total?: number;
  title: string;
  hint?: string;
  children: ReactNode;
  footer?: ReactNode;
};

export function StepShell({ step, total = 4, title, hint, children, footer }: Props) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="px-6 py-5 flex items-center justify-between border-b border-border/60">
        <Link to="/" className="font-semibold tracking-tight text-foreground">
          Echo <span className="text-primary">Eats</span>
        </Link>
        <div className="text-xs text-muted-foreground">
          Step {step} / {total}
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-xl">
          <div className="mb-6">
            <div className="flex gap-1.5">
              {Array.from({ length: total }).map((_, i) => (
                <div
                  key={i}
                  className={`h-1 flex-1 rounded-full ${
                    i < step ? "bg-primary" : "bg-border"
                  }`}
                />
              ))}
            </div>
          </div>
          <div className="bg-card border border-border rounded-2xl p-8 shadow-sm">
            <h1 className="text-2xl font-semibold tracking-tight text-card-foreground">
              {title}
            </h1>
            {hint && <p className="mt-2 text-sm text-muted-foreground">{hint}</p>}
            <div className="mt-6">{children}</div>
            {footer && <div className="mt-8">{footer}</div>}
          </div>
        </div>
      </main>
    </div>
  );
}
