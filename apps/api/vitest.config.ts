import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // swc emits decorator metadata, which Nest dependency injection needs.
    swc.vite({ module: { type: 'es6' } }),
  ],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
