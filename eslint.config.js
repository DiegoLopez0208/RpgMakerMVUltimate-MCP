import tseslint from 'typescript-eslint';

export default tseslint.config(
  tseslint.configs.recommended,
  {
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      // Intentionally-unused identifiers follow the underscore convention
      // (e.g. positional callback params `_ctx`, throwaway catch bindings `_`).
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }]
    },
    files: ['src/**/*.ts']
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Test fixtures deliberately inspect untyped RPG Maker JSON payloads.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }]
    }
  }
);
