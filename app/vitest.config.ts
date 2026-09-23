import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'renderer/src'), '@shared': resolve(__dirname, 'shared') } },
  test: { include: ['renderer/src/**/*.test.ts', 'shared/**/*.test.ts', 'main/src/**/*.test.ts'] },
})
