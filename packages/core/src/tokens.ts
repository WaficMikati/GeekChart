/**
 * 4Geeks design tokens.
 *
 * Values lifted from the token block in 4geeks.com's stylesheet (shadcn-style
 * HSL triples), so the charts sit next to their real UI without clashing.
 * Everything downstream reads from here — change a colour once, it propagates
 * to mermaid's own theme variables, our CSS layer and the exported HTML.
 */

export type Hsl = readonly [h: number, s: number, l: number];

export interface Palette {
  background: Hsl;
  foreground: Hsl;
  card: Hsl;
  muted: Hsl;
  mutedForeground: Hsl;
  border: Hsl;
  primary: Hsl;
  primaryForeground: Hsl;
  accent: Hsl;
  accentForeground: Hsl;
  /** Series colours, used to tint node groups and edge families. */
  chart: readonly [Hsl, Hsl, Hsl, Hsl, Hsl];
}

export const light: Palette = {
  background: [0, 0, 100],
  foreground: [223, 100, 5],
  card: [0, 0, 100],
  muted: [0, 0, 98],
  mutedForeground: [0, 0, 45],
  border: [0, 0, 90],
  primary: [210, 100, 50],
  primaryForeground: [0, 0, 100],
  accent: [43, 100, 55],
  accentForeground: [223, 100, 5],
  chart: [
    [210, 100, 50],
    [43, 100, 55],
    [142, 71, 45],
    [0, 75, 45],
    [40, 80, 55],
  ],
};

export const dark: Palette = {
  background: [0, 0, 8],
  foreground: [0, 0, 95],
  card: [0, 0, 10],
  muted: [0, 0, 14],
  mutedForeground: [0, 0, 65],
  border: [0, 0, 16],
  primary: [210, 100, 50],
  primaryForeground: [0, 0, 100],
  accent: [195, 100, 35],
  accentForeground: [0, 0, 100],
  chart: [
    [210, 100, 65],
    [9, 75, 65],
    [190, 70, 60],
    [280, 65, 65],
    [40, 80, 60],
  ],
};

export const fonts = {
  /** 4geeks.com uses Archivo for body copy and Lato for headings. */
  sans: '"Archivo", "Lato", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  heading: '"Lato", "Archivo", ui-sans-serif, system-ui, sans-serif',
  mono: 'ui-monospace, Menlo, "SF Mono", Consolas, monospace',
  /** Loaded from Google Fonts unless the caller asks for embedded fonts. */
  googleHref:
    'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Lato:wght@400;700;900&display=swap',
} as const;

export const radius = 12; // px — 4geeks --radius is .75rem

/** `hsl(h s% l%)` string, optionally with alpha. */
export function hsl([h, s, l]: Hsl, alpha = 1): string {
  return alpha === 1 ? `hsl(${h} ${s}% ${l}%)` : `hsl(${h} ${s}% ${l}% / ${alpha})`;
}

/**
 * Hex form. Mermaid runs its own colour maths (lighten/darken) over the theme
 * variables we hand it, and hex is the input it is best tested against.
 */
export function hex([h, s, l]: Hsl): string {
  const sat = s / 100;
  const lum = l / 100;
  const chroma = (1 - Math.abs(2 * lum - 1)) * sat;
  const second = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const match = lum - chroma / 2;
  const sextant = Math.floor(h / 60) % 6;
  const rgb = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ][sextant] as [number, number, number];
  return (
    '#' +
    rgb
      .map((c) =>
        Math.round((c + match) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** Nudge lightness, clamped. Used for hover/rim/shadow derivations. */
export function shift([h, s, l]: Hsl, delta: number): Hsl {
  return [h, s, Math.max(0, Math.min(100, l + delta))];
}

/** Move lightness towards a target while keeping hue — for subtle node fills. */
export function tint(color: Hsl, towards: number, amount: number): Hsl {
  const [h, s, l] = color;
  return [h, s, l + (towards - l) * amount];
}
