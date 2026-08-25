import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';

export interface CaptureOptions {
  html: string;
  /** Seconds of animation to cover. */
  runtime: number;
  fps: number;
  /** Device pixel ratio. 2 gives retina-sharp video from the same layout. */
  scale: number;
  /** Still seconds appended after the animation settles. */
  hold: number;
  /** Still seconds before it starts. */
  lead: number;
  background?: string;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) =>
      reject(new Error(`${command} could not be started: ${err.message}`)),
    );
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}\n${stderr.slice(-2000)}`)),
    );
  });
}

export async function ensureFfmpeg(): Promise<void> {
  try {
    await run('ffmpeg', ['-version']);
  } catch {
    throw new Error('ffmpeg is required for video output. Install it and try again.');
  }
}

/**
 * Render the animation to a numbered PNG sequence.
 *
 * Frames are produced by seeking, not by recording in real time: every CSS
 * animation is paused, then its `currentTime` is set to the exact millisecond
 * the frame represents. Nothing depends on how fast this machine is, so two runs
 * of the same chart produce identical files.
 */
async function captureFrames(page: Page, options: CaptureOptions, dir: string): Promise<number> {
  await page.setContent(options.html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  const animationCount = await page.evaluate(() => {
    const all = document.getAnimations();
    for (const animation of all) {
      animation.pause();
      // Seeking a not-yet-started animation throws unless it is given a start time.
      if (animation.startTime === null) animation.startTime = 0;
    }
    return all.length;
  });
  if (animationCount === 0) {
    throw new Error(
      'The page reported no animations to capture. Re-run with --preset cascade, ' +
        'or use --preset none and export a .png instead.',
    );
  }

  const box = await frameBox(page);

  const total = options.lead + options.runtime + options.hold;
  const frames = Math.max(1, Math.round(total * options.fps));

  for (let i = 0; i < frames; i++) {
    const at = Math.max(0, i / options.fps - options.lead) * 1000;
    await page.evaluate((ms) => {
      for (const animation of document.getAnimations()) {
        try {
          animation.currentTime = ms;
        } catch {
          /* an animation whose element was replaced mid-capture — skip it */
        }
      }
    }, at);
    await page.screenshot({
      path: join(dir, `f-${String(i).padStart(5, '0')}.png`),
      clip: box,
      // NOT `animations: 'disabled'` — that fast-forwards every animation to its
      // end before shooting, so every frame comes out as the final state. The
      // page is already still because we paused and seeked it ourselves.
      animations: 'allow',
    });
  }
  return frames;
}

/** Pixel dimensions must be even for yuv420p; the filter rounds them down. */
const EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

/** Cheap guard against a silently frozen capture: do the frames actually differ? */
async function assertFramesDiffer(dir: string, frames: number): Promise<void> {
  if (frames < 3) return;
  const { readFileSync } = await import('node:fs');
  const at = (i: number) => readFileSync(join(dir, `f-${String(i).padStart(5, '0')}.png`));
  const first = at(0);
  const middle = at(Math.floor(frames / 2));
  if (first.equals(middle)) {
    throw new Error(
      'Every captured frame is identical — the animation did not advance. ' +
        'This is a bug in the capture pipeline, not in your chart.',
    );
  }
}

/**
 * Measure the figure, giving it a viewport big enough to hold it first.
 *
 * A staged aspect can be taller than the default viewport — a 4:5 or 9:16 frame
 * always is — and a figure that does not fit is clipped by the screenshot rather
 * than scaled, so the bottom of the diagram silently goes missing.
 */
async function frameBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const wanted = await page.evaluate(() => {
    const figure = document.querySelector('.gc-figure') ?? document.body;
    const r = figure.getBoundingClientRect();
    return { width: Math.ceil(r.width), height: Math.ceil(r.height) };
  });
  await page.setViewportSize({
    width: Math.min(3000, Math.max(900, wanted.width + 40)),
    height: Math.min(3000, Math.max(700, wanted.height + 40)),
  });
  return page.evaluate(() => {
    const figure = document.querySelector('.gc-figure') ?? document.body;
    const r = figure.getBoundingClientRect();
    return {
      x: Math.floor(r.left),
      y: Math.floor(r.top),
      width: Math.ceil(r.width),
      height: Math.ceil(r.height),
    };
  });
}

export async function captureVideo(
  page: Page,
  options: CaptureOptions,
  output: string,
  format: 'mp4' | 'gif' | 'webm',
): Promise<{ frames: number; seconds: number }> {
  await ensureFfmpeg();
  const dir = mkdtempSync(join(tmpdir(), 'gc-frames-'));
  try {
    await page.setViewportSize({ width: 1600, height: 1200 });
    const frames = await captureFrames(page, options, dir);
    await assertFramesDiffer(dir, frames);
    const pattern = join(dir, 'f-%05d.png');

    if (format === 'gif') {
      const palette = join(dir, 'palette.png');
      await run('ffmpeg', [
        '-y', '-framerate', String(options.fps), '-i', pattern,
        '-vf', `${EVEN},palettegen=stats_mode=diff`, palette,
      ]);
      await run('ffmpeg', [
        '-y', '-framerate', String(options.fps), '-i', pattern, '-i', palette,
        '-lavfi', `${EVEN}[x];[x][1:v]paletteuse=dither=sierra2_4a`,
        '-loop', '0', output,
      ]);
    } else if (format === 'webm') {
      // VP9 defaults to its slowest search, which takes minutes on a long
      // sequence of large frames. `good` with a mid cpu-used and row threading
      // is the usual quality-per-second sweet spot.
      await run('ffmpeg', [
        '-y', '-framerate', String(options.fps), '-i', pattern,
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '32',
        '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-threads', '0',
        '-vf', EVEN, output,
      ]);
    } else {
      await run('ffmpeg', [
        '-y', '-framerate', String(options.fps), '-i', pattern,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-vf', EVEN, '-movflags', '+faststart', output,
      ]);
    }
    return { frames, seconds: frames / options.fps };
  } finally {
    // Scratch frames under the system temp dir.
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A single still of the finished diagram. */
export async function captureStill(
  page: Page,
  options: CaptureOptions,
  output: string,
): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.setContent(options.html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      if (animation.startTime === null) animation.startTime = 0;
      // Park every animation on its final frame.
      animation.currentTime = 10 ** 7;
    }
  });
  const box = await frameBox(page);
  await page.screenshot({ path: output, clip: box, animations: 'allow', scale: 'device' });
}
