import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      JWT_SECRET: 'test-jwt-secret-key-min-32-chars!!',
      JWT_REFRESH_SECRET: 'test-refresh-secret-key-min-32-chars!!',
    },
  },
});
