import tseslint from 'typescript-eslint';

export default tseslint.config(
  tseslint.configs.recommended,
  {
    rules: {
      'no-var': 'error',
      'prefer-const': 'error'
    },
    files: ['src/**/*.ts']
  }
);
