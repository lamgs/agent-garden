import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'scripts/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
    environment: 'node',
  },
});
