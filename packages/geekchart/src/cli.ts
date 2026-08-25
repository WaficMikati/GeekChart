/**
 * The `geekchart` bin.
 *
 * This is `@geekchart/cli`'s own `main`, bundled straight in — see
 * `packages/cli/src/index.ts` for the argument parsing and every format it
 * writes. Reusing it here rather than re-implementing anything against it
 * means there is exactly one CLI to keep working, not two that can drift.
 */
import { main } from '../../cli/src/index.ts';

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`\ngeekchart: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
