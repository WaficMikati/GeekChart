/**
 * DESIGN.md's numbered rules, as data.
 *
 * The executable form of a rule lives in `packages/cli/src/measure/` — this
 * file is what keeps that code from inventing its own copy of a number
 * DESIGN.md already names. Where the gate's threshold *is* geometry the
 * renderer already owns (the canvas bounds, the 8-grid, a clearance), `token`
 * names the `tokens.ts` export to read it from, and there is nothing further
 * to keep in sync. Where the gate invents a number with no renderer
 * counterpart (a detour ratio, a coverage floor, a bend count), `threshold`
 * is that number, still cited here rather than buried in the check.
 *
 * A rule with more than one number under it (6.1's ratio, pad and bend
 * counts; 6.5's two coverage ceilings and a minimum run) gets one entry per
 * number, keyed off the base id, rather than forcing a single scalar to
 * carry all of them.
 */
import { CANVAS, CLEARANCE, GRID } from './tokens.ts';

export interface Rule {
  /** One line: what the rule checks. */
  title: string;
  /** A gate-invented number with no renderer counterpart. */
  threshold?: number;
  /** Name of the tokens.ts export this rule's real threshold lives in. */
  token?: string;
}

export const RULES: Record<string, Rule> = {
  '1.1': {
    title: 'Canvas hugs its content: 480–1200 wide, snapped to 8',
    token: 'CANVAS',
  },
  '1.4': {
    title: 'Height never exceeds this multiple of width',
    threshold: CANVAS.maxAspect,
    token: 'CANVAS',
  },
  '2.1': {
    title: 'Positions, widths, heights and gutters sit on this grid',
    threshold: GRID,
    token: 'GRID',
  },
  '2.2': {
    title: 'At most this many distinct box sizes per chart',
    threshold: 2,
  },
  '2.3': {
    title: 'An edge shorter than this means its nodes are touching',
    threshold: CLEARANCE.node,
    token: 'CLEARANCE',
  },
  '3.1': {
    title: 'On-screen legibility floor, in px, at the gate viewing width',
    threshold: 8,
  },
  '6.1': {
    title: 'A forward edge is no longer than this multiple of the Manhattan distance between its ends',
    threshold: 1.4,
  },
  '6.1-detour-pad': {
    title: 'Flat padding added to the Manhattan distance before the detour ratio applies',
    threshold: 32,
  },
  '6.1-bends-forward': {
    title: 'Bends allowed on a forward edge',
    threshold: 2,
  },
  '6.1-bends-loop': {
    title: 'Bends allowed on a loop-back edge',
    threshold: 4,
  },
  '6.5': {
    title: "A label plate covers at most this share of the horizontal run it sits on",
    threshold: 0.6,
  },
  '6.5-vertical': {
    title: 'A label plate covers at most this share of the vertical run it sits on',
    threshold: 0.4,
  },
  '6.5-min-run': {
    title: "Shortest vertical run a label may sit on, rather than sitting beside it",
    threshold: 64,
  },
  '6.7': {
    title: "A loop-back is no longer than its nearest corridor's Manhattan distance plus this",
    threshold: 128,
  },
  '6.8': {
    title: 'Clearance an edge keeps from a node it does not connect to',
    threshold: CLEARANCE.node,
    token: 'CLEARANCE',
  },
  '6.9': {
    title: 'An edge label keeps this much clear of every node it does not belong to',
    threshold: 8,
  },
  '7.3': {
    title: 'Content is centred within this many units of the canvas centre',
    threshold: 8,
  },
  '7.4': {
    title: 'Content covers at least this share of the canvas area',
    threshold: 0.35,
  },
};
