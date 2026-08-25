#!/usr/bin/env node
import { main } from '../src/index.ts';

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`\ngeekchart: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
