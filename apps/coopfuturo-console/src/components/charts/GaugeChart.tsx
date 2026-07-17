"use client";

export function GaugeChart({
  value,
  label,
  size = 140,
}: {
  value: number;
  label?: string;
  size?: number;
}) {
  const clamped = Math.min(100, Math.max(0, value));
  const r = 52;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped / 100) * 0.75;
  const track = c * 0.75;

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size * 0.7} viewBox="0 0 140 100">
        <path
          d="M 18 90 A 52 52 0 1 1 122 90"
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="12"
          strokeLinecap="round"
        />
        <path
          d="M 18 90 A 52 52 0 1 1 122 90"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={`${track} ${c}`}
          strokeDashoffset={offset}
          className="transition-all duration-700"
        />
        <text x="70" y="72" textAnchor="middle" className="fill-[var(--text)] text-2xl font-semibold" style={{ fontSize: 28 }}>
          {clamped}%
        </text>
      </svg>
      {label && <p className="mt-1 text-xs text-[var(--muted)]">{label}</p>}
    </div>
  );
}
