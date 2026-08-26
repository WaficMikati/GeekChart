import {
  ALL_CHECKS,
  measureChart,
  runCheck,
  type Finding,
  type MeasureOptions,
  type MeasureResult,
} from './measure/index.ts';

declare global {
  interface Window {
    geekchartMeasure: {
      measureChart: (svg: SVGSVGElement, opts?: MeasureOptions) => MeasureResult;
      runCheck: (svg: SVGSVGElement, id: string, opts?: MeasureOptions) => Finding[];
      checks: { id: string; rule: string }[];
    };
  }
}

window.geekchartMeasure = {
  measureChart,
  runCheck,
  checks: ALL_CHECKS.map(({ id, rule }) => ({ id, rule })),
};

export {};
