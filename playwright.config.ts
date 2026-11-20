import { defineConfig } from '@playwright/test';

const PORT = 8445;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    permissions: ['camera'],
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  },
  // 事前に npm run build が必要（npm run test:e2e で自動的に行う）
  webServer: {
    command: `node server/dist/index.js --http --port ${PORT} --no-qr`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
