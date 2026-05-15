import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/when")({
  component: RedirectToCuisines,
});

function RedirectToCuisines() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate({ to: "/cuisines", replace: true });
  }, [navigate]);
  return null;
}
