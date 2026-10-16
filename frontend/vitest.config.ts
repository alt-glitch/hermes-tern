import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@tui': fileURLToPath(new URL('./.hermes-src/ui-tui/src', import.meta.url)) }, preserveSymlinks: true },
  test: { include: ['src/**/__tests__/**/*.test.ts'] }
})
