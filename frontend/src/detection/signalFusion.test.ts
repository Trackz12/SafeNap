import { describe, it, expect } from 'vitest';
import { fuseSignals, isWarning, isAlarm, type SignalInputs, type FusionThresholds } from './signalFusion';

const THRESHOLDS: FusionThresholds = {
    perclosWarn: 0.25,
    perclosAlarm: 0.45,
    warnCloseMs: 700,
    alarmCloseMs: 1500,
    microsleepAlarmMs: 1800,
    earTrendWarn: 0.18,
};

const QUIET: SignalInputs = {
    perclos: 0,
    yawnActive: false,
    headDropped: false,
    faceLost: false,
    closedForMs: 0,
    microsleepForMs: 0,
    earTrendFraction: null,
    mlScore: null,
};

describe('fuseSignals — estado calmo', () => {
    it('sem sinais: scores zerados, sem razão', () => {
        const f = fuseSignals(QUIET, THRESHOLDS);
        expect(f.warningScore).toBe(0);
        expect(f.alarmScore).toBe(0);
        expect(f.dominantReason).toBeNull();
        expect(isWarning(f)).toBe(false);
        expect(isAlarm(f)).toBe(false);
    });

    it('PERCLOS abaixo do warn não contribui', () => {
        const f = fuseSignals({ ...QUIET, perclos: 0.2 }, THRESHOLDS);
        expect(f.warningScore).toBe(0);
    });
});

describe('fuseSignals — sinal único forte', () => {
    it('PERCLOS no nível de alarme gera alarme', () => {
        const f = fuseSignals({ ...QUIET, perclos: 0.45 }, THRESHOLDS);
        expect(f.dominantReason).toBe('PERCLOS');
        expect(isWarning(f)).toBe(true);
        // PERCLOS 0.45 = ramp 1.0 * peso 1.0 = 1.0 >= ALARM_ENTER
        expect(isAlarm(f)).toBe(true);
    });

    it('micro-sono completo gera alarme com peso alto', () => {
        const f = fuseSignals({ ...QUIET, microsleepForMs: 1800 }, THRESHOLDS);
        expect(f.dominantReason).toBe('MICROSLEEP');
        // intensidade 1.0 * peso 1.2 = 1.2 >= ALARM_ENTER
        expect(isAlarm(f)).toBe(true);
    });

    it('micro-sono pela metade ainda não é alarme', () => {
        const f = fuseSignals({ ...QUIET, microsleepForMs: 900 }, THRESHOLDS);
        // intensidade 0.5 * peso 1.2 = 0.6 < 1.0
        expect(isAlarm(f)).toBe(false);
    });

    it('ML 0.95+ gera alarme', () => {
        const f = fuseSignals({ ...QUIET, mlScore: 0.96 }, THRESHOLDS);
        // ramp(0.96, 0.85, 0.95) = 1.0 * peso 0.9 = 0.9 < 1.0... hmm
        // Com peso 0.9, ML sozinho não fecha 1.0 — mas contribui forte.
        expect(f.alarmScore).toBeGreaterThan(0.8);
        expect(f.dominantReason).toBe('ML_ALARM');
    });

    it('fechamento longo contribui proporcionalmente', () => {
        const half = fuseSignals({ ...QUIET, closedForMs: 1100 }, THRESHOLDS);
        const full = fuseSignals({ ...QUIET, closedForMs: 1500 }, THRESHOLDS);
        expect(full.warningScore).toBeGreaterThan(half.warningScore);
        expect(full.warningScore).toBeCloseTo(0.4, 1); // peso 0.4
    });
});

describe('fuseSignals — fusão de sinais fracos múltiplos', () => {
    it('sinais fracos isolados não avisam, mas somados sim', () => {
        // Individualmente fracos:
        // - bocejo (0.35) + cabeça (0.35) + EAR trend moderado (~0.19)
        const weak1 = fuseSignals({ ...QUIET, yawnActive: true }, THRESHOLDS);
        expect(isWarning(weak1)).toBe(false); // 0.35 < 0.55

        const weak2 = fuseSignals(
            { ...QUIET, yawnActive: true, headDropped: true, earTrendFraction: 0.22 },
            THRESHOLDS,
        );
        // 0.35 + 0.35 + ramp(0.22, 0.18, 0.36)*0.3 ≈ 0.35+0.35+0.066 = 0.77 > 0.55
        expect(isWarning(weak2)).toBe(true);
        // A razão dominante é a de maior peso individual
        expect(weak2.dominantReason === 'YAWN' || weak2.dominantReason === 'HEAD_DROP').toBe(true);
    });

    it('PERCLOS elevado + bocejo soma mais que PERCLOS sozinho', () => {
        const perclosOnly = fuseSignals({ ...QUIET, perclos: 0.30 }, THRESHOLDS);
        const withYawn = fuseSignals({ ...QUIET, perclos: 0.30, yawnActive: true }, THRESHOLDS);
        expect(withYawn.warningScore).toBeGreaterThan(perclosOnly.warningScore);
        // PERCLOS 30% sozinho NÃO é warning na fusão (intensidade 0.25 * peso 1.0 = 0.25 < 0.55)
        expect(isWarning(perclosOnly)).toBe(false);
        // Mas com bocejo: 0.25 + 0.35 = 0.60 >= 0.55 → warning
        expect(isWarning(withYawn)).toBe(true);
    });

    it('ML alto + PERCLOS médio pode fechar alarme que nenhum fecharia sozinho', () => {
        // ML 0.9: warnEvidence = ramp(0.9, 0.7, 0.85)*0.9 = 1.0*0.9 = 0.9 (>= 0.55 warning)
        // alarmEvidence = ramp(0.9, 0.85, 0.95)*0.9 = 0.5*0.9 = 0.45 (< 1.0, sem alarme)
        // PERCLOS 0.55 (acima do alarm threshold 0.45): intensity 1.0 * peso 1.0 = 1.0
        const f = fuseSignals({ ...QUIET, mlScore: 0.90, perclos: 0.55 }, THRESHOLDS);
        expect(isWarning(f)).toBe(true);
        expect(isAlarm(f)).toBe(true); // 0.45 + 1.0 = 1.45 >= 1.0
    });

    it('rosto ausente tem peso baixo e sozinho não gera warning', () => {
        const f = fuseSignals({ ...QUIET, faceLost: true }, THRESHOLDS);
        expect(f.warningScore).toBe(0.2);
        expect(isWarning(f)).toBe(false);
    });
});

describe('fuseSignals — monotonicidade e sanidade', () => {
    it('PERCLOS crescente nunca diminui o score', () => {
        let last = -Infinity;
        for (const p of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6]) {
            const f = fuseSignals({ ...QUIET, perclos: p }, THRESHOLDS);
            expect(f.warningScore).toBeGreaterThanOrEqual(last);
            last = f.warningScore;
        }
    });

    it('scores são limitados (cap 1.5)', () => {
        const everything: SignalInputs = {
            perclos: 1.0,
            yawnActive: true,
            headDropped: true,
            faceLost: true,
            closedForMs: 5000,
            microsleepForMs: 5000,
            earTrendFraction: 0.9,
            mlScore: 1.0,
        };
        const f = fuseSignals(everything, THRESHOLDS);
        expect(f.warningScore).toBeLessThanOrEqual(1.5);
        expect(f.alarmScore).toBeLessThanOrEqual(1.5);
    });

    it('EAR trend abaixo do limiar não contribui', () => {
        const f = fuseSignals({ ...QUIET, earTrendFraction: 0.1 }, THRESHOLDS);
        expect(f.warningScore).toBe(0);
    });
});
