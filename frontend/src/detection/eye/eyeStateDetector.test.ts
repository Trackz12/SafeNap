import { describe, it, expect, beforeEach } from 'vitest';
import { EyeStateDetector } from './eyeStateDetector';
import { FakeClock } from '../temporal/clock';

const THRESHOLD = 0.21;
// Preset `standard` pós-auditoria de qualidade: confirmação por TEMPO (90ms)
// com piso de 2 quadros, em vez de contagem de 3 quadros.
const CONFIG = {
    closeConfirmMs: 90,
    closeConfirmMinFrames: 2,
    hysteresisFactor: 1.15,
    smoothingWindow: 3,
};

describe('EyeStateDetector — estado isolado, sem side effects', () => {
    let clock: FakeClock;
    let detector: EyeStateDetector;

    beforeEach(() => {
        clock = new FakeClock(1_000_000);
        detector = new EyeStateDetector(clock, CONFIG);
    });

    it('começa em UNKNOWN antes do primeiro frame', () => {
        expect(detector.getState()).toBe('UNKNOWN');
    });

    it('olhos abertos sustentados ficam em OPEN', () => {
        for (let i = 0; i < 5; i++) {
            clock.advance(33);
            const r = detector.update(0.35, THRESHOLD);
            expect(r.state).toBe('OPEN');
            expect(r.closed).toBe(false);
        }
    });

    it('abaixo do threshold mas ainda não confirmado vira CLOSING, não CLOSED', () => {
        clock.advance(33);
        const r1 = detector.update(0.05, THRESHOLD);
        expect(r1.state).toBe('CLOSING');
        expect(r1.closed).toBe(false);
        clock.advance(33);
        const r2 = detector.update(0.05, THRESHOLD);
        // 2º quadro: piso de quadros satisfeito (2), mas só 33ms abaixo do
        // limiar — falta tempo para os 90ms de closeConfirmMs.
        expect(r2.state).toBe('CLOSING');
    });

    it('piscada normal: OPEN → CLOSING → CLOSED → OPEN, fecha o segmento com a duração certa', () => {
        for (let i = 0; i < 5; i++) { clock.advance(33); detector.update(0.35, THRESHOLD); }
        // 5 quadros de 33ms. O 1º é absorvido pela mediana-3 (buffer ainda
        // cheio de 0.35), então a contagem de tempo abaixo do limiar começa no
        // 2º; com closeConfirmMs=90 a confirmação sai no 5º (99ms abaixo).
        let last;
        for (let i = 0; i < 5; i++) { clock.advance(33); last = detector.update(0.05, THRESHOLD); }
        expect(last!.state).toBe('CLOSED');
        expect(last!.closedForMs).toBeGreaterThan(0);

        // A mediana-3 também se aplica na reabertura: 1 quadro de 0.35 não
        // basta pra dominar um buffer ainda cheio de 0.05 (mediana fica em
        // 0.05); precisa de 2 quadros pra mediana virar 0.35.
        clock.advance(33); detector.update(0.35, THRESHOLD);
        clock.advance(33);
        const reopened = detector.update(0.35, THRESHOLD);
        expect(reopened.state).toBe('OPEN');
        expect(reopened.closedSegmentEnded).not.toBeNull();
        expect(reopened.closedSegmentEnded!.durationMs).toBeGreaterThan(0);
        expect(reopened.closedSegmentEnded!.durationMs).toBeLessThan(400);
    });

    it('zona de histerese (ear suavizado entre threshold e threshold*hysteresisFactor) reporta OPENING, ainda closed=true', () => {
        // 4 quadros de 33ms = 99ms abaixo do limiar (>= closeConfirmMs=90).
        // Com a regra antiga (3 quadros) bastavam 3; agora o que conta é o
        // tempo decorrido, e 3 quadros a 30 FPS são só 66ms.
        for (let i = 0; i < 4; i++) { clock.advance(33); detector.update(0.05, THRESHOLD); }
        expect(detector.getState()).toBe('CLOSED'); // pré-condição do cenário
        // O EAR reportado é o SUAVIZADO (mediana-3): precisa de 2 leituras de
        // 0.22 pra dominar a mediana (buffer [0.05,0.22,0.22] -> mediana 0.22),
        // dentro da zona-morta: > threshold(0.21), < threshold*1.15(0.2415).
        clock.advance(33); detector.update(0.22, THRESHOLD);
        clock.advance(33);
        const r = detector.update(0.22, THRESHOLD);
        expect(r.state).toBe('OPENING');
        expect(r.closed).toBe(true); // continua fechado pela histerese
    });

    it('ruído de 1 quadro isolado nem chega a CLOSING: a mediana-3 já absorve o pico antes do threshold', () => {
        for (let i = 0; i < 5; i++) { clock.advance(33); detector.update(0.35, THRESHOLD); }
        clock.advance(33);
        // Buffer antes do push: [0.35,0.35,0.35] -> depois [0.35,0.35,0.05] ->
        // mediana ainda 0.35 (o pico de ruído de 1 quadro nunca chega a virar
        // "abaixo do threshold"; é a mediana, não o closeConfirmFrames, que
        // filtra esse caso específico).
        const noisy = detector.update(0.05, THRESHOLD);
        expect(noisy.state).toBe('OPEN');
        expect(noisy.ear).toBeCloseTo(0.35, 5);
    });

    it('markUnknown() fecha um segmento em aberto e zera os contadores (evita o bug de "since" sobrevivendo à perda de rosto)', () => {
        for (let i = 0; i < 5; i++) { clock.advance(33); detector.update(0.05, THRESHOLD); }
        expect(detector.getState()).toBe('CLOSED');

        clock.advance(5000); // rosto some por 5s
        const ended = detector.markUnknown();
        expect(ended).not.toBeNull();
        expect(detector.getState()).toBe('UNKNOWN');

        // Rosto reaparece com 1 único quadro de EAR baixo (ruído comum de reaquisição).
        clock.advance(100);
        const r = detector.update(0.05, THRESHOLD);
        expect(r.state).toBe('CLOSING'); // não CLOSED instantâneo herdando o "since" antigo
        expect(r.closedForMs).toBe(0);
    });
});
