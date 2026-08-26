import {
  ALL_CHECKS,
  measureChart,
  type MeasureOptions,
  type MeasureResult,
} from './measure/index.ts';

declare global {
  interface Window {
    geekchartMeasure: {
      measureChart: (svg: SVGSVGElement, opts?: MeasureOptions) => MeasureResult;
      checks: { id: string; rule: string }[];
    };
  }
}

window.geekchartMeasure = {
  measureChart,
  checks: ALL_CHECKS.map(({ id, rule }) => ({ id, rule })),
};

export {};
