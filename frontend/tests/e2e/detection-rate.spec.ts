import { test, expect } from '@playwright/test';
import { mockCamera } from './helpers/camera';

/**
 * Cadência REAL de detecção, medida no navegador com o app de verdade.
 *
 * Por que isto existe: toda a resolução temporal do SafeNap depende de quantos
 * quadros por segundo o laço de `vision/mediapipe.ts` consegue processar (ver
 * `detection/eye/eyeStateDetector.ts` — confirmação de fechamento em ms, mas
 * limitada pelo período de amostragem). Antes de 2026-09-24 o laço esperava
 * `setTimeout(100ms)` FIXO mais um `requestAnimationFrame`, o que dava ~9 FPS,
 * enquanto a interface exibia a taxa de RENDER (~60) rotulada como "FPS". Este
 * teste mede a coisa certa e falha se a cadência regredir para o patamar antigo.
 *
 * Nota de ambiente: o MediaPipe WASM pode não carregar em CI (rede/bundle). O
 * app trata isso com `aiError`; neste caso o teste registra que não mediu em vez
 * de reprovar por um motivo que não é o do teste.
 */
test('mede a cadência real de detecção no navegador', async ({ page }) => {
    await mockCamera(page);
    await page.goto('/');

    const btn = page.locator('button', { hasText: /iniciar|tentar novamente/i }).first();
    await expect(btn).toBeEnabled({ timeout: 20_000 });

    if (/tentar novamente/i.test((await btn.textContent()) ?? '')) {
        test.skip(true, 'MediaPipe WASM não carregou neste ambiente — nada a medir.');
    }

    await btn.click();

    // O badge de FPS é atualizado 1x/s a partir de mediaPipeManager.getDetectionFps().
    const badge = page.getByText(/^\d+ FPS$/);
    await expect(badge).toBeVisible({ timeout: 20_000 });

    // Deixa a média exponencial estabilizar antes de ler.
    await expect
        .poll(async () => {
            const txt = (await badge.textContent()) ?? '0 FPS';
            return Number.parseInt(txt, 10);
        }, { timeout: 25_000, intervals: [1000] })
        .toBeGreaterThan(0);

    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(1000);
        samples.push(Number.parseInt((await badge.textContent()) ?? '0', 10));
    }
    const achieved = Math.max(...samples);

    // Custo por quadro: o título do badge expõe `getLastDetectMs()`, que cobre
    // MediaPipe + EAR + regras.
    //
    // LIMITE DESTA MEDIDA: o stream sintético do mock NÃO contém um rosto
    // humano (o assert abaixo confirma isso lendo o badge de status). Sem rosto
    // detectado, o MediaPipe pula o estágio de refinamento de landmarks, então
    // o valor medido aqui é um PISO INFERIOR do custo real, não o custo com
    // rosto presente. Medir o custo com rosto exige vídeo humano real e fica
    // como validação de campo — não citar este número como "o custo do
    // MediaPipe" sem essa ressalva.
    const title = (await badge.getAttribute('title')) ?? '';
    const costMatch = /: ([\d.]+) ms/.exec(title);
    const costMs = costMatch ? Number.parseFloat(costMatch[1]) : NaN;
    console.log(`[medição] cadência de detecção observada: ${JSON.stringify(samples)} -> pico ${achieved} FPS`);
    console.log(`[medição] custo do passo de detecção (MediaPipe + EAR + regras): ${costMs} ms`);

    // O stream sintético não contém um rosto humano. Registrar isso é
    // essencial: sem rosto detectado, o MediaPipe pula o estágio de landmarks e
    // o custo medido é um PISO INFERIOR, não o custo com rosto real.
    const semRosto = await page.getByText('Sem rosto', { exact: true }).count();
    const monitorando = await page.getByText('Monitorando', { exact: true }).count();
    console.log(`[medição] rosto detectado durante a medição? "Sem rosto"=${semRosto} "Monitorando"=${monitorando}`);
    // Trava a ressalva acima: se algum dia o mock passar a conter um rosto real,
    // este assert falha e obriga a reinterpretar (e recitar) o custo medido.
    expect(semRosto, 'o mock passou a conter um rosto? reinterprete o custo medido').toBe(1);

    // O custo por quadro precisa caber no orçamento, senão o teto de ciclo de
    // trabalho reduz a cadência por design.
    expect(Number.isFinite(costMs), `título do badge sem custo legível: "${title}"`).toBe(true);
    expect(costMs).toBeLessThan(100);

    // Guarda de regressão, não alvo de desempenho: o laço antigo (setTimeout
    // fixo de 100ms + rAF) ficava preso em ~9 FPS. Qualquer valor claramente
    // acima disso prova que o orçamento de quadro adaptativo está em vigor.
    // O teto fica em aberto de propósito — depende do hardware e do teto de
    // ciclo de trabalho, que reduz a taxa em máquina lenta por design.
    expect(achieved, `cadência observada ${achieved} FPS — laço voltou ao patamar antigo?`).toBeGreaterThan(12);
});
