import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

export function Pill({ children, tone }: { children: ReactNode; tone?: "green" | "red" | "amber" | "blue" }) {
  return <span className={`pill${tone ? ` pill-${tone}` : ""}`}>{children}</span>;
}

export function LoadingState({ label = "Cargando..." }: { label?: string }) {
  return (
    <div className="center-state">
      <RefreshCw size={22} className="spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ label }: { label: string }) {
  return <div className="empty">{label}</div>;
}
