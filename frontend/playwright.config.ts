import { defineConfig, devices } from '@playwright/test';

/**
 * E2E do SafeNap — testes de UI sem hardware real.
 *
 * A câmera é mockada via addInitScript (getUserMedia retorna um stream de
 * canvas animado), então os testes rodam em qualquer CI sem webcam.
 * O backend NÃO é necessário: o frontend tolera WebSocket offline.
 */
export default defineConfig({
    testDir: './tests/e2e',
    timeout: 30_000,
    expect: { timeout: 5_000 },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 2 : undefined,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        baseURL: 'http://localhost:4173',
        trace: 'on-first-retry',
        // Permissões de câmera/mic concedidas — o stream em si é mockado
        permissions: ['camera'],
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    webServer: {
        command: 'npm run build && npm run preview -- --port 4173 --strictPort',
        url: 'http://localhost:4173',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
