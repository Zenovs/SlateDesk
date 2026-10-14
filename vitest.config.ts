import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts: unit tests cover pure state logic only and
// need neither the React plugin nor the multi-page build setup.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
