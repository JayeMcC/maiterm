import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// Flat config. Runs against Svelte 5 sources + backend-adjacent TS.
// Kept intentionally lenient at bootstrap so the baseline lint pass doesn't
// drown in style-only warnings; tighten individual rules later as needed.
export default [
  {
    ignores: [
      'node_modules/**',
      '.svelte-kit/**',
      'build/**',
      'dist/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
      'tests/e2e/**', // has its own tsconfig + vitest setup
      'scripts/cli-llm-cassette.mjs', // symlink into a sibling repo
      'website/**', // separate project
      'update-worker/**', // separate deployable
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs['flat/recommended'],

  {
    // eslint-plugin-svelte's recommended config uses svelte-eslint-parser for
    // .svelte files, but the parser only descends into <script lang="ts"> when
    // it's told which TS parser to delegate to. Without this, TS inside
    // components fails to parse ("Unexpected token {").
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },

  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // Unused-import cleanup is useful, but leading-underscore signals
      // "intentionally unused" (destructuring patterns, callback ergonomics).
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // The codebase leans on `any` in a handful of well-audited spots
      // (event payloads, MCP tool args). Keep as warning so new usage is
      // visible but not blocking.
      '@typescript-eslint/no-explicit-any': 'warn',

      // The codebase renders ANSI/PTY output which is literally control
      // characters in regexes — flagging them is noise, not signal.
      'no-control-regex': 'off',
      // `\$` in template-literal-ish contexts triggers false positives.
      'no-useless-escape': 'off',
      // Legitimate concerns already audited at call sites (rendered content is
      // sanitised markdown / built-in help). Keep as warnings so new usage is
      // still flagged.
      'svelte/no-at-html-tags': 'warn',

      // The pre-existing codebase carries a backlog under these rules; treat
      // them as warnings so new offenders are visible while the historical
      // ones ratchet down over time. Each has a genuine reason to fix
      // eventually (Svelte 5 reactivity, key-based reconciliation, dead
      // suppression comments left from the Svelte 4 → 5 migration).
      'svelte/no-unused-svelte-ignore': 'warn',
      'svelte/prefer-svelte-reactivity': 'warn',
      'svelte/require-each-key': 'warn',
      'svelte/no-useless-mustaches': 'warn',
      'svelte/prefer-writable-derived': 'warn',
      'no-useless-assignment': 'warn',
    },
  },

  // Prettier last so it wins on any style-shaped rules.
  prettier,
];
