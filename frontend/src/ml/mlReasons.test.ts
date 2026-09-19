import { describe, it, expect } from 'vitest';
import { combineWarningReason, combineAlarmReason, isCorroboratingWarning } from './mlReasons';
import { ML_WARNING_THRESHOLD, ML_ALARM_THRESHOLD } from './thresholds';

describe('combineWarningReason', () => {
    it('modo rules ignora o ML', () => {
        expect(combineWarningReason('rules', null, 0.99)).toBeNull();
        expect(combineWarningReason('rules', 'YAWN', 0.99)).toBe('YAWN');
    });

    it.each(['ml', 'hybrid'] as const)('modo %s: ML acima do limiar gera ML_WARNING; abaixo cai nas regras', (mode) => {
        expect(combineWarningReason(mode, null, ML_WARNING_THRESHOLD)).toBe('ML_WARNING');
        expect(combineWarningReason(mode, 'PERCLOS', 0.99)).toBe('ML_WARNING');
        expect(combineWarningReason(mode, 'PERCLOS', ML_WARNING_THRESHOLD - 0.01)).toBe('PERCLOS');
        expect(combineWarningReason(mode, null, ML_WARNING_THRESHOLD - 0.01)).toBeNull();
    });

    it.each(['rules', 'ml', 'hybrid'] as const)('modo %s: ML indisponível (null) → só regras', (mode) => {
        expect(combineWarningReason(mode, 'HEAD_DROP', null)).toBe('HEAD_DROP');
        expect(combineWarningReason(mode, null, null)).toBeNull();
    });
});

describe('combineAlarmReason — o ML não origina ALARM sozinho (modelo EXPERIMENTAL/não validado)', () => {
    it('regra de alarme passa direto em qualquer modo, com ou sem ML', () => {
        for (const mode of ['rules', 'ml', 'hybrid'] as const) {
            expect(combineAlarmReason(mode, 'EYES_CLOSED_DURATION', null, null)).toBe('EYES_CLOSED_DURATION');
            expect(combineAlarmReason(mode, 'PERCLOS_CRITICAL', 0.1, null)).toBe('PERCLOS_CRITICAL');
        }
    });

    it.each(['ml', 'hybrid'] as const)('modo %s: ML ≥ 0,95 SEM nenhuma regra de aviso → não alarma', (mode) => {
        expect(combineAlarmReason(mode, null, 0.99, null)).toBeNull();
    });

    it.each(['ml', 'hybrid'] as const)('modo %s: ML ≥ 0,95 + regra de aviso fisiológica → ML_ALARM', (mode) => {
        for (const w of ['PERCLOS', 'YAWN', 'HEAD_DROP', 'PROLONGED_CLOSE', 'EAR_TREND', 'SLOW_BLINKS'] as const) {
            expect(combineAlarmReason(mode, null, ML_ALARM_THRESHOLD, w)).toBe('ML_ALARM');
        }
    });

    it('FACE_LOST não conta como corroboração (não é evidência de sonolência)', () => {
        expect(isCorroboratingWarning('FACE_LOST')).toBe(false);
        expect(isCorroboratingWarning(null)).toBe(false);
        expect(combineAlarmReason('hybrid', null, 0.99, 'FACE_LOST')).toBeNull();
    });

    it('ML abaixo de 0,95 nunca alarma, mesmo com regra de aviso', () => {
        expect(combineAlarmReason('hybrid', null, ML_ALARM_THRESHOLD - 0.01, 'PERCLOS')).toBeNull();
    });

    it('modo rules nunca usa o ML', () => {
        expect(combineAlarmReason('rules', null, 0.99, 'PERCLOS')).toBeNull();
    });

    it('modos ml e hybrid são hoje equivalentes (documentado: ml NÃO é "só ML")', () => {
        const cases: Array<[Parameters<typeof combineAlarmReason>[1], number | null, Parameters<typeof combineAlarmReason>[3]]> = [
            [null, 0.99, 'PERCLOS'], [null, 0.99, null], ['MICROSLEEP', 0.2, null], [null, null, 'YAWN'],
        ];
        for (const [r, s, w] of cases) {
            expect(combineAlarmReason('ml', r, s, w)).toBe(combineAlarmReason('hybrid', r, s, w));
        }
    });
});
