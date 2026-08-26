import type { Analysis } from './types.ts';
import type { StyleSpec } from './styles.ts';

const SVG = 'http://www.w3.org/2000/svg';

/**
 * Decoration added to the SVG after mermaid is done with it.
 *
 * Everything here is additive and behind or on top of the diagram, never a
 * change to it — if a pack turns these off, or a diagram type has no nodes to
 * hang them on, the chart is exactly what mermaid drew.
 */

/** Faint dot grid, painted behind everything. */
export function addPaper(svg: SVGSVGElement, id: string): void {
  const viewBox = svg.viewBox.baseVal;
  const width = viewBox.width || svg.clientWidth;
  const height = viewBox.height || svg.clientHeight;
  if (!width || !height) return;

  // Our own <defs> as a direct child. Mermaid nests its defs inside a group for
  // class, ER and state diagrams, so reusing whatever `querySelector` finds
  // leaves us inserting siblings into the wrong parent.
  const defs = document.createElementNS(SVG, 'defs');
  const pattern = document.createElementNS(SVG, 'pattern');
  pattern.setAttribute('id', `${id}-paper`);
  pattern.setAttribute('width', '22');
  pattern.setAttribute('height', '22');
  pattern.setAttribute('patternUnits', 'userSpaceOnUse');
  const dot = document.createElementNS(SVG, 'circle');
  dot.setAttribute('cx', '1');
  dot.setAttribute('cy', '1');
  dot.setAttribute('r', '0.9');
  dot.setAttribute('fill', 'currentColor');
  dot.setAttribute('opacity', '0.14');
  pattern.appendChild(dot);
  defs.appendChild(pattern);
  svg.insertBefore(defs, svg.firstChild);

  // Bleed past the viewBox so the grid reaches the panel's padding rather than
  // stopping at the diagram's bounding box. The SVG does not clip it away
  // because the root is set to `overflow: visible`.
  const bleed = 80;
  const wash = document.createElementNS(SVG, 'rect');
  wash.setAttribute('class', 'gc-paper');
  wash.setAttribute('x', String((viewBox.x || 0) - bleed));
  wash.setAttribute('y', String((viewBox.y || 0) - bleed));
  wash.setAttribute('width', String(width + bleed * 2));
  wash.setAttribute('height', String(height + bleed * 2));
  wash.setAttribute('fill', `url(#${id}-paper)`);
  wash.setAttribute('pointer-events', 'none');
  // After <defs> but before the diagram, so it never covers a node.
  svg.insertBefore(wash, defs.nextSibling);
}

/**
 * Step numbers in the corner of each node, from the wave the node belongs to.
 *
 * The numbering is the diagram's own reading order, which is why it can be
 * generated rather than authored.
 */
export function addStepNumbers(svg: SVGSVGElement, analysis: Analysis): void {
  // Decide what gets a numeral first, then number the waves that survived.
  // Counting skipped nodes leaves the diagram starting at "02", which reads as a
  // missing step rather than a deliberate one.
  const eligible = analysis.elements.filter((element) => {
    if (element.kind !== 'node') return false;
    const box = element.el.getBoundingClientRect();
    return box.width >= 52 && box.height >= 26;
  });

  const waves = [...new Set(eligible.map((e) => e.wave))].sort((a, b) => a - b);
  const stepOf = new Map(waves.map((wave, index) => [wave, index + 1]));

  for (const element of eligible) {
    const step = stepOf.get(element.wave)!;
    const box = element.el.getBoundingClientRect();

    // The numeral is appended inside the node's own group, so its coordinates
    // have to be in that group's user space — not the root's. Nodes carry a
    // translate, and using the root matrix scatters the numbers across the page.
    const toLocal = (element.el as SVGGraphicsElement).getScreenCTM()?.inverse();
    if (!toLocal) continue;
    // Above the top-left corner rather than inside the box. Node labels are
    // centred and often fill the width, so an inset numeral collides with the
    // text on every short node.
    const corner = new DOMPoint(box.left + 1, box.top - 6).matrixTransform(toLocal);

    const text = document.createElementNS(SVG, 'text');
    text.setAttribute('class', 'gc-index');
    text.setAttribute('x', corner.x.toFixed(1));
    text.setAttribute('y', corner.y.toFixed(1));
    text.setAttribute('text-anchor', 'start');
    text.setAttribute('font-size', '9.5');
    text.textContent = String(step).padStart(2, '0');
    element.el.appendChild(text);
  }
}

export function decorate(
  svg: SVGSVGElement,
  analysis: Analysis,
  spec: StyleSpec,
  id: string,
): void {
  if (spec.dotGrid) addPaper(svg, id);
  if (spec.numbering) addStepNumbers(svg, analysis);
}
