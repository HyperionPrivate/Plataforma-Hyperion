"use client";

import { motion } from "motion/react";
import { Phone, MessageCircle } from "lucide-react";
import { pulse, slide } from "@/lib/motion";
import { cn } from "@/lib/utils";

export type LiveEvent = {
  id: string;
  channel: "voz" | "whatsapp";
  personName: string;
  kind: string;
  at: string;
};

export function LiveDot({ className }: { className?: string }) {
  return (
    <motion.span
      className={cn("inline-block size-2 rounded-full bg-[var(--accent)]", className)}
      animate={pulse.animate}
      aria-hidden
    />
  );
}

export function LiveFeed({ events }: { events: LiveEvent[] }) {
  return (
    <section className="flex h-full flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">Actividad en tiempo real</h3>
        <span className="flex items-center gap-1.5 text-xs text-[var(--accent)]">
          <LiveDot /> En vivo
        </span>
      </div>
      <ul className="flex flex-1 flex-col gap-2 overflow-y-auto">
        {events.map((e, i) => (
          <motion.li
            key={e.id}
            variants={slide}
            initial={i === 0 ? "hidden" : false}
            animate="show"
            className={cn(
              "flex gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg)]/40 p-2.5",
              i === 0 && "ring-1 ring-[var(--accent)]/40"
            )}
          >
            <span className="mt-0.5 text-[var(--accent)]">
              {e.channel === "voz" ? (
                <Phone className="size-[18px]" strokeWidth={1.75} />
              ) : (
                <MessageCircle className="size-[18px]" strokeWidth={1.75} />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{e.personName}</p>
              <p className="text-xs text-[var(--accent)]">{e.kind}</p>
            </div>
            <time className="shrink-0 text-[10px] tabular text-[var(--muted)]">{e.at}</time>
          </motion.li>
        ))}
      </ul>
      <button type="button" className="mt-3 text-left text-xs text-[var(--accent)] hover:underline">
        Ver todas las actividades →
      </button>
    </section>
  );
}
