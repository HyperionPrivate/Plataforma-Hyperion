import { useMemo, useState } from "react";
import { Card, CardHead, EmptyState } from "../../components/ui.js";
import type { ReviewRow } from "./types.js";

type ReviewFilter = "pending_review" | "approved" | "skipped" | "sent" | "all";

export function NovaReviewsTab({
  reviews,
  canWriteOps,
  onDecide
}: {
  reviews: ReviewRow[];
  canWriteOps: boolean;
  onDecide: (reviewId: string, decision: "approve" | "skip") => Promise<void>;
}) {
  const [filter, setFilter] = useState<ReviewFilter>("pending_review");
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    if (filter === "all") return reviews;
    return reviews.filter((row) => row.status === filter);
  }, [filter, reviews]);

  const selected = filtered.find((row) => row.review_id === selectedId) ?? filtered[0];

  async function decide(decision: "approve" | "skip") {
    if (!selected || !canWriteOps) return;
    setBusy(true);
    try {
      await onDecide(selected.review_id, decision);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {(
          [
            ["pending_review", "Pendientes"],
            ["approved", "Aprobados"],
            ["skipped", "Omitidos"],
            ["sent", "Enviados"],
            ["all", "Todos"]
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`chip${filter === id ? " active" : ""}`}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(240px, 1fr) minmax(240px, 1fr)", gap: 16 }}>
        <Card>
          <CardHead title="Cola WhatsApp post-llamada" />
          {filtered.length === 0 ? (
            <EmptyState label="Sin revisiones en este filtro." />
          ) : (
            <ul className="col" style={{ gap: 6, listStyle: "none", padding: 0, margin: 0 }}>
              {filtered.map((review) => (
                <li key={review.review_id}>
                  <button
                    type="button"
                    className={`chip${selected?.review_id === review.review_id ? " active" : ""}`}
                    style={{ width: "100%", justifyContent: "flex-start" }}
                    onClick={() => setSelectedId(review.review_id)}
                  >
                    {review.review_id.slice(0, 8)} · {review.status} · {review.intent ?? "—"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHead title="Decisión" />
          {!selected ? (
            <EmptyState label="Selecciona un caso." />
          ) : (
            <div className="col" style={{ gap: 10 }}>
              <p>
                Review <strong>{selected.review_id}</strong>
              </p>
              <p className="muted tiny">
                Contacto {selected.contact_id.slice(0, 8)} · call {selected.call_id?.slice(0, 8) ?? "—"} · intent{" "}
                {selected.intent ?? "—"}
              </p>
              <p className="muted tiny">Estado: {selected.status}</p>
              <div className="row" style={{ gap: 8 }}>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={!canWriteOps || busy || selected.status !== "pending_review"}
                  onClick={() => void decide("approve")}
                >
                  Aprobar / enviar WA
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={!canWriteOps || busy || selected.status !== "pending_review"}
                  onClick={() => void decide("skip")}
                >
                  Omitir
                </button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
