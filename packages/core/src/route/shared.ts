import type { Point } from '../geometry.ts';

/**
 * Types and constants every route/ module reaches for: which face an edge
 * uses (DESIGN 6.1's orthogonal H/V, DESIGN 6.2's perpendicular attach), the
 * box geometry DESIGN 6.1/6.7's clearance and DESIGN 6.4's fan-spacing checks
 * are measured against, and the per-side outward normal every port and
 * contact point is built from.
 */

export type Side = 'left' | 'right' | 'top' | 'bottom';

export const NORMALS: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

export const isVertical = (side: Side): boolean => side === 'top' || side === 'bottom';

/** The axis-aligned box an edge attaches to, or has to clear. */
export interface Extent {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Something a route must not run through. `holds` names a panel's children. */
export interface Obstacle {
  id: string;
  box: Extent;
  holds?: readonly string[];
}

/** Where a face sits, centred on its own axis. */
export const faceMiddle = (box: Extent, side: Side): number =>
  isVertical(side) ? box.x + box.width / 2 : box.y + box.height / 2;
