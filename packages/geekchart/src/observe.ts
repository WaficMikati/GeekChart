/**
 * Start a paused chart's build once it scrolls into view, and hold there.
 *
 * DESIGN 8.4: `renderToSvg`/`renderToHtml` (and `<Geekchart>`) default to
 * `play: 'in-view'` — the finished markup ships with `data-gc-play="in-view"`
 * on its `<svg>` and every one of its animations paused at frame zero (see
 * `@geekchart/core`'s `animate.ts`, `applyPlayMode`/`playModeCss`). Nothing
 * un-pauses that on its own: a page that never calls this function shows a
 * paused, blank-looking chart to any reader whose OS is not also asking for
 * reduced motion.
 *
 * No framework, no bundler-specific glue — this file imports nothing, so it
 * is safe to drop into a plain `<script type="module">` on a page with no
 * other JavaScript at all. Call it once, any time after the markup this
 * package rendered is in the DOM (a page script, a framework's mount hook,
 * an MPA's shared layout — wherever runs once per page).
 */
export function playInView(root: ParentNode = document, threshold = 0.4): () => void {
  const targets = root.querySelectorAll('[data-gc-play="in-view"]');

  // No `IntersectionObserver` here (an old browser, a non-browser DOM): play
  // immediately rather than leave every chart paused with nothing that will
  // ever unpause it.
  if (typeof IntersectionObserver === 'undefined') {
    targets.forEach((el) => el.setAttribute('data-gc-playing', ''));
    return () => {};
  }

  // `threshold` is the share of the chart that must be on screen. A chart
  // taller than the screen (a phone layout, DESIGN 1.6) would otherwise wait
  // until the reader had scrolled 40% of the way into it — past a blank,
  // paused top — so for those the share is scaled to 30% of the viewport's
  // own height instead, whichever is smaller. One observer per distinct
  // share; each target is watched once and released when it plays.
  const viewport = typeof window !== 'undefined' ? window.innerHeight : 0;
  const observers = new Map<number, IntersectionObserver>();
  const observerFor = (share: number): IntersectionObserver => {
    let o = observers.get(share);
    if (!o) {
      o = new IntersectionObserver(
        (entries, self) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            entry.target.setAttribute('data-gc-playing', '');
            // Once each: DESIGN 8.4's build-out plays a single pass, not once
            // per scroll in and out of view.
            self.unobserve(entry.target);
          }
        },
        { threshold: share },
      );
      observers.set(share, o);
    }
    return o;
  };
  targets.forEach((el) => {
    const height = el.getBoundingClientRect().height;
    const share =
      viewport > 0 && height > 0 ? Math.min(threshold, (0.3 * viewport) / height) : threshold;
    observerFor(Math.round(share * 100) / 100).observe(el);
  });
  return () => observers.forEach((o) => o.disconnect());
}
