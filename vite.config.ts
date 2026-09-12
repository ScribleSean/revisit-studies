import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { coverageConfigDefaults } from 'vitest/config';

// https://vitejs.dev/config/
export default defineConfig(({ command, mode, isPreview }) => {
  const env = loadEnv(mode, process.cwd());

  return {
    server: { proxy: { '/api/review': 'http://127.0.0.1:3001' } },
    base: command === 'build' || isPreview ? env.VITE_BASE_PATH : '/',
    plugins: [
      react({ devTarget: 'es2022' }),
    ],
    resolve: {
      alias: {
        // Hjson's Node entry reads os.EOL at startup; use its shipped browser bundle.
        hjson: 'hjson/bundle/hjson.js',
        // /esm/icons/index.mjs only exports the icons statically, so no separate chunks are created
        '@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
        // UpSet treats this peer as optional, but Vite still resolves its dynamic import during pre-bundling.
        '@trrack/vis-react': fileURLToPath(new URL('./src/shims/trrackVisReact.ts', import.meta.url)),
      },
    },
    test: {
      environment: 'jsdom',
      // The analysis bridge uses Node's test runner via yarn test:review-api.
      exclude: ['./tests/**', 'node_modules/**', 'server/review/tests/**'],
      fileParallelism: true,
      maxWorkers: '100%',
      minWorkers: 1,
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          ...coverageConfigDefaults.exclude,
          'public/**',
          'src/public/**',
          'dist/**',
          'eslint.config.js',
          'vite.config.ts',
          'playwright.config.ts',
          'src/vite-env.d.ts',
          'src/lodash.d.ts',
          'src/main.tsx',
          'src/analysis/types.ts',
          'tests/checkSavedAnswers.ts',
          'tests/utils.ts',
        ],
      },
    },
  };
});
