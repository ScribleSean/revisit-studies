/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react-swc';

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd());

  const massApiPort = env.VITE_MASS_API_PORT || '3001';

  return {
    base: command === 'build' ? env.VITE_BASE_PATH : '/',
    plugins: [
      react({ devTarget: 'es2022' }),
    ],
    server: {
      proxy: {
        '/api/analyze-large': {
          target: `http://127.0.0.1:${massApiPort}`,
          changeOrigin: true,
        },
        '/api/health': {
          target: `http://127.0.0.1:${massApiPort}`,
          changeOrigin: true,
        },
        '/api/analyze-timeline': {
          target: `http://127.0.0.1:${massApiPort}`,
          changeOrigin: true,
        },
      },
    },
    resolve: {
      alias: {
        // /esm/icons/index.mjs only exports the icons statically, so no separate chunks are created
        '@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
      },
    },
    test: {
      exclude: ['./tests/**', 'node_modules/**'],
      setupFiles: ['vitest-localstorage-mock'],
      fileParallelism: true,
      maxWorkers: '100%',
      minWorkers: 1,
    },
  };
});
