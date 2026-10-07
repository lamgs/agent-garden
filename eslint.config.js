import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '.tsbuild/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Only the redactor (and the store, reading back already-redacted rows) may brand text.
      'no-restricted-syntax': [
        'error',
        {
          selector: "TSAsExpression > TSTypeReference.typeAnnotation[typeName.name='RedactedText']",
          message:
            'Do not cast to RedactedText. Pass text through Redactor (packages/ingest/src/redact).',
        },
      ],
    },
  },
  {
    files: ['packages/ingest/src/redact/**', 'packages/ingest/src/store/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
