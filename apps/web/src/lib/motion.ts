import type { Transition, Variants } from "motion/react";

export const easeOut = [0.16, 1, 0.3, 1] as const;

export const transitions = {
  instant: { duration: 0.1, ease: easeOut } satisfies Transition,
  fast: { duration: 0.2, ease: easeOut } satisfies Transition,
  base: { duration: 0.35, ease: easeOut } satisfies Transition,
  chart: { duration: 0.7, ease: easeOut } satisfies Transition,
  number: { duration: 0.8, ease: easeOut } satisfies Transition,
  liveGlow: { duration: 1.2, ease: easeOut } satisfies Transition,
};

export const fade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: transitions.base },
};

export const slide: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: transitions.base },
};

export const scale: Variants = {
  hidden: { opacity: 0, scale: 0.98 },
  show: { opacity: 1, scale: 1, transition: transitions.base },
};

export const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
};

export const page = fade;
export const modal = scale;
export const drawer: Variants = {
  hidden: { opacity: 0, x: 16 },
  show: { opacity: 1, x: 0, transition: transitions.fast },
};
export const toast = slide;
export const chart = fade;
export const number = fade;

export const pulse = {
  animate: {
    scale: [1, 1.15, 1],
    opacity: [1, 0.7, 1],
    transition: { duration: 1.6, repeat: Infinity, ease: "easeInOut" as const },
  },
};

export const liveGlow = {
  initial: { boxShadow: "0 0 0 0 rgba(52,211,153,0)" },
  animate: {
    boxShadow: [
      "0 0 0 0 rgba(52,211,153,0.45)",
      "0 0 0 8px rgba(52,211,153,0)",
    ],
    transition: transitions.liveGlow,
  },
};
