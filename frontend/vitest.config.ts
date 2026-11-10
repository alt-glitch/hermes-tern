import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { preserveSymlinks: true },
  test: { include: ['src/**/__tests__/**/*.test.ts'], maxWorkers: 2 }
})
