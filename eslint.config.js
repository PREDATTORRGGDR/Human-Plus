import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'dist/**', 'probe-output/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { 'no-eval': 'error', 'no-new-func': 'error', 'no-implied-eval': 'error' },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },
];
