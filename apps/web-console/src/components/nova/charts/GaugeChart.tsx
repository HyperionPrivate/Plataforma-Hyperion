export function GaugeChart({
  value,
  label,
  size = 140
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
    <div className="col" style={{ alignItems: "center" }}>
      <svg width={size} height={size * 0.7} viewBox="0 0 140 100" aria-label={label ?? `${clamped}%`}>
        <path
          d="M 18 90 A 52 52 0 1 1 122 90"
          fill="none"
          stroke="rgba(128,128,128,0.2)"
          strokeWidth="12"
          strokeLinecap="round"
        />
        <path
          d="M 18 90 A 52 52 0 1 1 122 90"
          fill="none"
          stroke="var(--accent, #2f9e6e)"
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={`${track} ${c}`}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.7s ease" }}
        />
        <text x="70" y="72" textAnchor="middle" fill="currentColor" style={{ fontSize: 28, fontWeight: 600 }}>
          {clamped}%
        </text>
      </svg>
      {label ? <p className="muted tiny">{label}</p> : null}
    </div>
  );
}
