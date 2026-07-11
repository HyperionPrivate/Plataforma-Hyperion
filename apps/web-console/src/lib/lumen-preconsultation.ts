import type { LumenPreconsultationSummary } from "@hyperion/contracts";

export type LumenSummarySource = LumenPreconsultationSummary["sources"][number];
export type LumenSummaryTrend = LumenPreconsultationSummary["trends"][number];

export function lumenSummarySourceById(
  summary: LumenPreconsultationSummary,
  sourceId: string | null | undefined
): LumenSummarySource | undefined {
  return sourceId ? summary.sources.find((source) => source.id === sourceId) : undefined;
}

export function lumenAlertSource(
  summary: LumenPreconsultationSummary,
  alertIndex: number
): LumenSummarySource | undefined {
  return lumenSummarySourceById(summary, summary.alertSourceIds[alertIndex]);
}

export function lumenTrendDomain(trends: readonly LumenSummaryTrend[]): { min: number; max: number } {
  const values = trends.flatMap((trend) => [
    ...trend.points.map((point) => point.value),
    ...(trend.targetMin == null ? [] : [trend.targetMin]),
    ...(trend.targetMax == null ? [] : [trend.targetMax])
  ]);
  if (values.length === 0) return { min: 0, max: 1 };
  const min = Math.floor(Math.min(...values) - 2);
  const max = Math.ceil(Math.max(...values) + 2);
  return max === min ? { min: min - 1, max: max + 1 } : { min, max };
}

export function lumenTrendTargetLabel(trend: LumenSummaryTrend): string | undefined {
  if (trend.targetMin != null && trend.targetMax != null) {
    return `${trend.targetMin}–${trend.targetMax} ${trend.unit}`;
  }
  if (trend.targetMax != null) return `≤ ${trend.targetMax} ${trend.unit}`;
  if (trend.targetMin != null) return `≥ ${trend.targetMin} ${trend.unit}`;
  return undefined;
}
