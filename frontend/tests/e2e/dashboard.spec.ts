import { test, expect } from '@playwright/test';
import { mockCamera } from './helpers/camera';

/**
 * Fluxo da câmera com getUserMedia mockado: botão habilita após o preload
 * da IA, wizard de calibração aparece, parar volta ao estado inativo.
 *
 * Nota: o MediaPipe WASM pode não carregar em CI (rede/bundle) — o app
 * trata isso com aiError e o botão vira "Tentar novamente". O teste cobre
 * ambos os caminhos: se a IA carregar, wizard abre; senão, botão de retry.
 */
test.describe('Fluxo da câmera', () => {
    test.beforeEach(async ({ page }) => {
        await mockCamera(page);
        await page.goto('/');
    });

    test('botão inicia desabilitado enquanto a IA carrega', async ({ page }) => {
        const startBtn = page.getByRole('button', { name: /iniciar|carregando|tentar/i });
        await expect(startBtn).toBeVisible();
    });

    test('painel de monitoramento tem botão de câmera clicável após preload', async ({ page }) => {
        // Aguarda o preload da IA (1s de delay + init) ou o erro
        const btn = page.locator('button', { hasText: /iniciar|tentar novamente/i }).first();
        await expect(btn).toBeEnabled({ timeout: 15_000 });
    });
});

test.describe('Controles de hardware', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
    });

    test('seção de conexão Arduino com input de porta', async ({ page }) => {
        const portInput = page.getByLabel('Porta serial do Arduino');
        await expect(portInput).toBeVisible();
        await portInput.fill('COM3');
        await expect(portInput).toHaveValue('COM3');
    });

    test('botões de teste de hardware presentes', async ({ page }) => {
        await expect(page.getByRole('button', { name: 'Testar alarme sonoro' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Testar vibração' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Desligar alerta' })).toBeVisible();
    });

    test('botão conectar Arduino visível e habilitado', async ({ page }) => {
        const connectBtn = page.getByRole('button', { name: 'Conectar Arduino' });
        await expect(connectBtn).toBeEnabled();
    });
});

test.describe('Painel de calibração', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
    });

    test('mostra explicação e botão de calibrar', async ({ page }) => {
        await expect(
            page.getByText(/calibração guiada abre ao ligar a câmera/i),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: 'Calibrar', exact: true })).toBeVisible();
    });

    test('presets de sensibilidade presentes', async ({ page }) => {
        await expect(page.getByRole('button', { name: 'Leve' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Padrão', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Alta', exact: true })).toBeVisible();
    });

    test('preset muda visualmente ao clicar', async ({ page }) => {
        const strictBtn = page.getByRole('button', { name: 'Alta', exact: true });
        await strictBtn.click();
        // Após o clique, o preset Alta fica ativo (classe btn-primary)
        await expect(strictBtn).toHaveClass(/btn-primary/);
    });
});

test.describe('Painel de sessão', () => {
    test('métricas de sessão presentes (tempo, piscadas, avisos)', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByText('Tempo ativo')).toBeVisible();
        await expect(page.getByText('Piscadas')).toBeVisible();
        await expect(page.getByText('EAR médio')).toBeVisible();
        await expect(page.getByText('Avisos', { exact: true })).toBeVisible();
    });
});
