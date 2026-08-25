// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lints the `geekchart` package — the one thing in this repo that ships to
 * npm. The other packages (`core`, `cli`, `react`, `web`) predate this config
 * and are not gated by it; bringing them up to a lint baseline is a separate
 * pass, not something to bundle into wiring the linter up in the first place.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.gate/**', 'gallery.html'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
