import { test, expect } from '@playwright/test';

/**
 * Smoke: a aplicação carrega com o shell básico — header, painéis e
 * StatusGauge — sem backend (WebSocket offline é tolerado pelo design).
 */
test.describe('App smoke', () => {
    test('carrega o header com o título SafeNap', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('heading', { level: 1, name: 'SafeNap' })).toBeVisible();
        await expect(
            page.getByText('Sistema Inteligente de Detecção de Fadiga'),
        ).toBeVisible();
    });

    test('mostra os painéis principais do dashboard', async ({ page }) => {
        await page.goto('/');

        // Painéis do dashboard (main + sidebar) — exact evita colisão com
        // textos longos do painel de histórico.
        await expect(page.getByText('Monitoramento', { exact: true })).toBeVisible();
        await expect(page.getByText('Últimos 60 segundos', { exact: true })).toBeVisible();
        await expect(page.getByText('Sessão atual', { exact: true })).toBeVisible();
        await expect(page.getByText('Calibração', { exact: true }).first()).toBeVisible();
        await expect(page.getByText('Controles', { exact: true })).toBeVisible();
        await expect(page.getByText('Treinamento ML', { exact: true })).toBeVisible();
        await expect(page.getByText('Histórico', { exact: true })).toBeVisible();
    });

    test('StatusGauge exibe PERCLOS inicial em NORMAL', async ({ page }) => {
        await page.goto('/');
        // O gauge mostra o label PERCLOS (aparece 2x: gauge + legenda do gráfico)
        await expect(page.getByText('PERCLOS', { exact: true }).first()).toBeVisible();
        await expect(page.getByText('Normal', { exact: true }).first()).toBeVisible();
    });

    test('área da câmera mostra estado inativo antes de iniciar', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByText('Câmera inativa')).toBeVisible();
    });

    test('gráfico ao vivo mostra mensagem de espera de dados', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByText('Aguardando dados…')).toBeVisible();
    });
});
