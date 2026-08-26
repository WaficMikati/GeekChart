/**
 * Small helpers shared by more than one layout pass. DESIGN 2.1 (the 8-grid
 * every coordinate lands on).
 */

export const onGrid = (v: number, step = 8) => Math.round(v / step) * step;
