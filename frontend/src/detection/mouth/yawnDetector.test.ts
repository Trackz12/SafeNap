import { describe, it, expect, beforeEach } from 'vitest';
import { YawnDetector } from './yawnDetector';
import { FakeClock } from '../temporal/clock';

const CONFIG = { mouthAspectThreshold: 0.65, minMs: 400, cooldownMs: 10000 };

describe('YawnDetector', () => {
    let clock: FakeClock;
    let detector: YawnDetector;

    beforeEach(() => {
        clock = new FakeClock(1_000_000);
        detector = new YawnDetector(clock, CONFIG);
    });

    it('boca aberta sustentada por >= minMs confirma bocejo (justStarted só no frame de confirmação)', () => {
        let sawStart = false;
        let last;
        for (let i = 0; i < 6; i++) {
            clock.advance(100);
            last = detector.update(0.75);
            if (last.justStarted) sawStart = true;
        }
        expect(last!.active).toBe(true);
        expect(sawStart).toBe(true);
    });

    it('boca aberta breve (< minMs) não confirma', () => {
        clock.advance(100);
        const r = detector.update(0.75);
        expect(r.active).toBe(false);
    });

    it('cooldown mantém active=true por um tempo após a boca fechar', () => {
        for (let i = 0; i < 6; i++) { clock.advance(100); detector.update(0.75); }
        clock.advance(100);
        const closedButCooldown = detector.update(0.15);
        expect(closedButCooldown.active).toBe(true);

        clock.advance(CONFIG.cooldownMs + 100);
        const afterCooldown = detector.update(0.15);
        expect(afterCooldown.active).toBe(false);
    });
});
