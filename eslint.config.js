// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'frontend/**',
      'coverage/**',
      '**/*.d.ts',
      // Vendored agent skills — reference material, not this project's code.
      'claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Config files live outside tsconfig's `include` but still get linted.
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts', '*.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The brief explicitly forbids scattering `any`. Make it an error, not a warning.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',

      // Secrets hygiene: console.log bypasses the redacting logger.
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
      'no-restricted-globals': ['error', 'name', 'length'],

      // ----------------------------------------------------------------
      // "Zero secrets in the codebase" — enforced by the linter, not by
      // discipline. src/config.ts is the only sanctioned reader of env.
      // ----------------------------------------------------------------
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read environment variables only in src/config.ts. Everything else must receive typed config as an argument, so credentials never spread through the codebase.',
        },
      ],
    },
  },
  {
    // The one module allowed to touch the environment.
    files: ['src/config.ts'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
  {
    // Entry points and tooling legitimately read env before config exists
    // (e.g. to pick a transport) and run outside the server process.
    files: ['scripts/**/*.ts', 'vitest.config.ts', 'eslint.config.js'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
  {
    // Scripts, examples and tests are allowed to talk to stdout directly:
    // printing IS their output, not incidental logging.
    files: ['scripts/**/*.ts', 'tests/**/*.ts', 'mcp/**/*.ts', 'examples/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
