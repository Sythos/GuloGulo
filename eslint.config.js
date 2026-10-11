// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import noUnsanitized from 'eslint-plugin-no-unsanitized';
import globals from 'globals';

// eslint-plugin-security's own recommended config ships every rule at 'warn',
// and that's kept as-is here rather than promoted to 'error'. Reviewing the
// actual hits in this codebase (not just the rule names) showed the volume
// concentrates in a handful of known-high-false-positive shapes: bounded
// validation regexes (`{0,61}`-style domain/id patterns) tripping
// detect-unsafe-regex's conservative heuristic, and internally-validated
// dynamic paths (secret store, backup adapter, packaging stager — all gated
// by a pattern check before the fs call) tripping detect-non-literal-fs-
// filename and detect-object-injection. Genuine hits stay visible in
// `npm run lint` output for review; they just don't fail CI on their own.
const securityRules = security.configs.recommended.rules;

// External JSON and driver data enter through validated boundaries.
// Keep the existing no-unsafe-* rule settings; enabling that separate rule
// family requires its own review. Explicit any is now an error.
//
// require-await also fires wherever an adapter's method is declared `async`
// purely to satisfy a shared interface (see `PlatformAdapter` in
// `src/platform/contract/platform-adapter.ts`) rather than because it awaits
// anything; every sibling implementation of the same method does await, so
// the signature has to stay async for the type to line up across adapters.
//
// Keep whole-file type-check bypasses and ts-ignore banned.
const typeAwareRuleAdjustments = {
  '@typescript-eslint/no-unsafe-argument': 'off',
  '@typescript-eslint/no-unsafe-assignment': 'off',
  '@typescript-eslint/no-unsafe-call': 'off',
  '@typescript-eslint/no-unsafe-member-access': 'off',
  '@typescript-eslint/no-unsafe-return': 'off',
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/require-await': 'off',
  '@typescript-eslint/ban-ts-comment': ['error', {
    'ts-nocheck': true,
    'ts-ignore': true,
    'ts-expect-error': 'allow-with-description',
  }],
  // Matches this codebase's existing convention for deliberately-unused
  // parameters kept only for interface conformance (e.g. a not-yet-
  // implemented adapter method that fails closed).
  '@typescript-eslint/no-unused-vars': ['error', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  }],
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'web/dist/**',
      'packaging/dist/**',
      'coverage/**',
      '**/node_modules/**',
    ],
  },

  // Node-side TypeScript covered by tsconfig.lp9.json: full type-aware linting.
  // projectService only auto-discovers files literally named tsconfig.json,
  // so it's pointed at the lp9 project (src + scripts + web/src + web build
  // and test entry points) explicitly instead.
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'web/build.ts', 'web/test/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    plugins: { security },
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.lp9.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: { ...securityRules, ...typeAwareRuleAdjustments },
  },

  // Browser source uses the same strict checks as the server source.
  {
    files: ['web/src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked, noUnsanitized.configs.recommended],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        project: ['./tsconfig.lp9.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: typeAwareRuleAdjustments,
  },

  // packaging/**/*.ts sits outside every tsconfig project (it runs through
  // --experimental-strip-types, never tsc), so lint it syntax-only.
  {
    files: ['packaging/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { security },
    languageOptions: { globals: globals.node },
    rules: { ...securityRules, ...typeAwareRuleAdjustments },
  },

  // The only hand-written .mjs outside the documented compatibility bridges.
  {
    files: ['packaging/standalone/scripts/run-migrations.mjs'],
    extends: [js.configs.recommended],
    plugins: { security },
    languageOptions: { globals: globals.node, ecmaVersion: 2022, sourceType: 'module' },
    rules: securityRules,
  },

  // Every test file registers its cases as top-level `test(name, async fn)`
  // calls from node:test and relies on the runner to sequence them; none of
  // them are awaited or chained, by design, so no-floating-promises would
  // flag the entire suite for a pattern that isn't a bug.
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
);
