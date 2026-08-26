// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * Lints the renderer (`core`), the CLI/gallery/gate tooling (`cli`), the React
 * wrapper (`react`) and the published `geekchart` package. `web` is a Vite app
 * with its own build pipeline and stays out of this pass.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.gate/**',
      'gallery.html',
      // The measurement gate. AGENT-BRIEF.md forbids implementation agents
      // from ever editing this file, so it cannot live under a linter that
      // would otherwise demand its findings get fixed here.
      'packages/cli/scripts/gate.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The gallery/bench/build scripts are plain Node ESM, but several of them
    // hand callbacks to Playwright's `page.evaluate`, which run inside the
    // browser page rather than in Node — so both global sets are needed in
    // the same file.
    files: ['packages/cli/scripts/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['packages/react/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Only the two classic hook-correctness rules, not the full v7
      // React-Compiler ruleset (purity, immutability, refs, …) — this repo's
      // one component isn't reviewed against those, so turning them on would
      // just be noise.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['packages/geekchart/**/*.{ts,tsx}'],
    rules: {
      // Escape hatches used deliberately in a few places (dynamic imports
      // whose shape can't be typed without pulling in the module they defer).
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
