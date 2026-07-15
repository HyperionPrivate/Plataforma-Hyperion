"use client";

type HeatmapProps = {
  days: string[];
  hours: string[];
  values: number[][];
  unitLabel?: string;
};

/** Verde oscuro = baja conversión/respuesta · Verde claro/brillante = alta */
export function ConversionHeatmap({ days, hours, values, unitLabel = "Conversión" }: HeatmapProps) {
  return (
    <div>
      <div className="overflow-x-auto">
        <div className="min-w-[280px]">
          <div
            className="mb-1 grid gap-1"
            style={{ gridTemplateColumns: `44px repeat(${hours.length}, minmax(0, 1fr))` }}
          >
            <div />
            {hours.map((h) => (
              <div key={h} className="text-center text-[10px] text-[var(--muted)]">
                {h}
              </div>
            ))}
          </div>
          <div className="space-y-1">
            {days.map((day, row) => (
              <div
                key={day}
                className="grid items-center gap-1"
                style={{ gridTemplateColumns: `44px repeat(${hours.length}, minmax(0, 1fr))` }}
              >
                <span className="text-[10px] text-[var(--muted)]">{day}</span>
                {(values[row] ?? []).map((v, col) => {
                  const pct = Math.round(v * 100);
                  return (
                    <div
                      key={`${day}-${col}`}
                      className="aspect-square rounded-sm"
                      style={{ background: `rgba(52,211,153,${0.12 + v * 0.88})` }}
                      title={`${day} ${hours[col]}: ${pct}% ${unitLabel.toLowerCase()}`}
                      aria-label={`${day} ${hours[col]} ${pct}%`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className="text-[10px] text-[var(--muted)]">Baja</span>
        <div
          className="h-2 flex-1 rounded-full"
          style={{
            background: "linear-gradient(90deg, rgba(52,211,153,0.12), rgba(52,211,153,1))",
          }}
          aria-hidden
        />
        <span className="text-[10px] text-[var(--muted)]">Alta</span>
      </div>
      <p className="mt-1 text-[10px] text-[var(--muted)]">
        {unitLabel}: verde oscuro = baja · verde brillante = alta. Pasa el cursor sobre una celda para ver el %.
      </p>
    </div>
  );
}
