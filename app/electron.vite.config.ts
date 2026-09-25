import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const shared = resolve(__dirname, 'shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { lib: { entry: resolve(__dirname, 'main/src/index.ts') } },
    resolve: { alias: { '@shared': shared } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'preload/src/index.ts'),
          browser: resolve(__dirname, 'preload/src/browser.ts'),
          poster: resolve(__dirname, 'preload/src/poster.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
    resolve: { alias: { '@shared': shared } },
  },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    plugins: [react()],
    define: { __RELEASE_NOTES__: JSON.stringify(readFileSync(resolve(__dirname, '..', 'RELEASE_NOTES.md'), 'utf8')) },
    build: { minify: 'esbuild', rollupOptions: { input: resolve(__dirname, 'renderer/index.html') } },
    resolve: { alias: { '@': resolve(__dirname, 'renderer/src'), '@shared': shared } },
  },
})
