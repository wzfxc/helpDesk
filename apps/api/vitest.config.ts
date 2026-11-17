import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // swc emits decorator metadata, which Nest dependency injection needs.
    swc.vite({ module: { type: 'es6' } }),
  ],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Integration tests share one real PostgreSQL database and reset it between files.
    fileParallelism: false,
    passWithNoTests: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      WORKER_ENABLED: 'false',
    },
  },
});
