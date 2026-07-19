import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`card${className ? ` ${className}` : ""}`}>{children}</div>;
}

export function CardHead({ title, icon, trailing }: { title: string; icon?: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="card-head">
      {icon}
      <h2>{title}</h2>
      {trailing ? <div className="spacer">{trailing}</div> : null}
    </div>
  );
}

export function Kpi({
  label,
  value,
  icon,
  trend
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  trend?: { value: string; up: boolean };
}) {
  return (
    <Card className="kpi">
      <span className="kpi-label">
        {icon}
        {label}
      </span>
      <span className="kpi-value">{value}</span>
      {trend ? <span className={`kpi-trend ${trend.up ? "trend-up" : "trend-down"}`}>{trend.value}</span> : null}
    </Card>
  );
}

export function Pill({ children, tone }: { children: ReactNode; tone?: "green" | "red" | "amber" | "blue" }) {
  return <span className={`pill${tone ? ` pill-${tone}` : ""}`}>{children}</span>;
}

export function Avatar({ name }: { name?: string | null }) {
  const initials = (name ?? "?")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return <span className="avatar">{initials || "?"}</span>;
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
