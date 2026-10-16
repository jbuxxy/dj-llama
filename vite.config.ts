import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Fallbacks ('dev'/'local') must stay in sync with src/version.ts.
  define: {
    'process.env.DJLLAMA_GIT_SHA': JSON.stringify(process.env.DJLLAMA_GIT_SHA ?? 'dev'),
    'process.env.DJLLAMA_CHANNEL': JSON.stringify(process.env.DJLLAMA_CHANNEL ?? 'local'),
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  root: '.',
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: path.resolve(__dirname, 'index.html'),
        spotifyBridge: path.resolve(__dirname, 'spotify-embed-bridge.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    alias: { '@': path.resolve(__dirname, './src') },
    coverage: {
      // istanbul, not v8: this suite runs under Bun (JavaScriptCore), which
      // doesn't implement the V8 inspector coverage API @vitest/coverage-v8
      // depends on -- that provider silently reports 0% for every file here.
      // Istanbul instruments source at transform time instead, so it works
      // regardless of JS engine.
      provider: 'istanbul',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/web/**/*.tsx',
        'src/index.ts',
        'src/**/types.ts',
        'src/**/*.d.ts',
        'src/db/schema.ts',
        'src/server/openapi.ts',
        'drizzle/**',
      ],
      // A ratchet just under current coverage (2026-10: 73 / 68.6 / 60.7 /
      // 70.8), so CI catches a drop; raise these as coverage improves.
      thresholds: {
        lines: 72,
        functions: 68,
        branches: 60,
        statements: 70,
      },
    },
  },
})
