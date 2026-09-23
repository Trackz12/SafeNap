import { describe, it, expect, beforeEach } from 'vitest';
import { HeadDropDetector } from './headDropDetector';
import { FakeClock } from '../temporal/clock';

const CONFIG = { margin: 0.07, minMs: 2000 };
const BASELINE = 0.30;

describe('HeadDropDetector', () => {
    let clock: FakeClock;
    let detector: HeadDropDetector;

    beforeEach(() => {
        clock = new FakeClock(1_000_000);
        detector = new HeadDropDetector(clock, CONFIG);
    });

    it('sem baseline calibrado, nunca reporta dropped', () => {
        clock.advance(3000);
        const r = detector.update(0.9, null, false);
        expect(r.dropped).toBe(false);
    });

    it('queda sustentada + olhos NÃO alertas confirma dropped (regressão real, 2026-09-23)', () => {
        let last;
        for (let i = 0; i < 21; i++) { clock.advance(100); last = detector.update(BASELINE + 0.15, BASELINE, false); }
        expect(last!.dropped).toBe(true);
    });

    it('queda sustentada + olhos ALERTAS (olhando pro painel/celular) NÃO confirma — bug real corrigido', () => {
        let last;
        for (let i = 0; i < 26; i++) { clock.advance(100); last = detector.update(BASELINE + 0.15, BASELINE, true); }
        expect(last!.dropped).toBe(false);
    });

    it('duração curta não confirma mesmo com olhos não-alertas', () => {
        let last;
        for (let i = 0; i < 5; i++) { clock.advance(100); last = detector.update(BASELINE + 0.15, BASELINE, false); }
        expect(last!.dropped).toBe(false);
    });
});
