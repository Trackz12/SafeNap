import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
        // tests/e2e é do Playwright (playwright.config.ts) — excluído do vitest
        exclude: ['tests/e2e/**', 'node_modules/**'],
    },
});
