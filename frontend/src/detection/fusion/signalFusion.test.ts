import { describe, it, expect } from 'vitest';
import { fuseSignals, type FusionInputs, type FusionThresholds } from './signalFusion';

const THRESHOLDS: FusionThresholds = {
    perclosWarn: 0.25,
    perclosAlarm: 0.45,
    warnCloseMs: 700,
    alarmCloseMs: 1500,
    microsleepAlarmMs: 1800,
    earTrendWarn: 0.18,
    mlWarnThreshold: 0.85,
    mlAlarmThreshold: 0.95,
};

const QUIET: FusionInputs = {
    perclos: 0,
    yawnActive: false,
    headDropped: false,
    faceLost: false,
    closedForMs: 0,
    microsleepForMs: 0,
    microsleepMeetsThreshold: false,
    earTrendFraction: null,
    slowBlinksActive: false,
    mlScore: null,
    mode: 'hybrid',
};

describe('fuseSignals — estado calmo', () => {
    it('sem sinais: NORMAL, scores zerados, sem razão', () => {
        const f = fuseSignals(QUIET, THRESHOLDS);
        expect(f.state).toBe('NORMAL');
        expect(f.warningScore).toBe(0);
        expect(f.alarmScore).toBe(0);
        expect(f.primaryReason).toBeNull();
        expect(f.contributingSignals).toEqual([]);
    });
});

describe('fuseSignals — camada 1 (indicadores fortes, prioridade fixa)', () => {
    it('PERCLOS no nível de alarme dispara direto por regra forte (PERCLOS_CRITICAL), não pelo fallback', () => {
        const f = fuseSignals({ ...QUIET, perclos: 0.45 }, THRESHOLDS);
        expect(f.state).toBe('ALARM');
        expect(f.primaryReason).toBe('PERCLOS_CRITICAL');
    });

    it('PERCLOS no nível de aviso (abaixo do alarme) dispara WARNING por regra forte', () => {
        const f = fuseSignals({ ...QUIET, perclos: 0.30 }, THRESHOLDS);
        expect(f.state).toBe('WARNING');
        expect(f.primaryReason).toBe('PERCLOS');
    });

    it('microsleepMeetsThreshold dispara ALARM por MICROSLEEP, prioridade sobre os demais', () => {
        const f = fuseSignals({ ...QUIET, microsleepMeetsThreshold: true, perclos: 0.30 }, THRESHOLDS);
        expect(f.primaryReason).toBe('MICROSLEEP');
    });

    it('fechamento >= alarmCloseMs dispara EYES_CLOSED_DURATION', () => {
        const f = fuseSignals({ ...QUIET, closedForMs: 1500 }, THRESHOLDS);
        expect(f.state).toBe('ALARM');
        expect(f.primaryReason).toBe('EYES_CLOSED_DURATION');
    });

    it('SLOW_BLINKS só vale quando nenhum outro sinal de aviso de prioridade maior está ativo', () => {
        const alone = fuseSignals({ ...QUIET, slowBlinksActive: true }, THRESHOLDS);
        expect(alone.primaryReason).toBe('SLOW_BLINKS');
        const withYawn = fuseSignals({ ...QUIET, slowBlinksActive: true, yawnActive: true }, THRESHOLDS);
        expect(withYawn.primaryReason).toBe('YAWN'); // YAWN tem prioridade maior na cadeia
    });
});

describe('fuseSignals — camada 3 (fallback contínuo, sinais de suporte fracos combinados)', () => {
    it('bocejo sozinho já é WARNING pela regra forte (YAWN é regra forte, não fallback — preservado da cadeia original)', () => {
        const f = fuseSignals({ ...QUIET, yawnActive: true }, THRESHOLDS);
        expect(f.state).toBe('WARNING');
        expect(f.primaryReason).toBe('YAWN');
    });

    it('sinais que NENHUM é regra forte isolada (EAR_TREND moderado sozinho) não fecham warning, mas combinados sim', () => {
        // EAR_TREND é regra forte quando >= earTrendWarn — aqui uso um valor
        // abaixo do limiar de regra forte para exercitar genuinamente o
        // fallback contínuo (ramp cresce a partir de earTrendWarn*0.5 na
        // pontuação de ML, mas earTrendFraction só soma no fallback quando
        // já bateu earTrendWarn; o teste abaixo isola sinais que só entram
        // pelo scoring contínuo — ML fraco + PERCLOS abaixo do warn).
        const weak = fuseSignals({ ...QUIET, perclos: 0.20, mlScore: 0.75 }, THRESHOLDS);
        expect(weak.state).toBe('NORMAL'); // nenhuma regra forte, score combinado ainda baixo
        const combined = fuseSignals({ ...QUIET, perclos: 0.24, mlScore: 0.84 }, THRESHOLDS);
        expect(combined.state).toBe('WARNING'); // agora soma o suficiente pelo fallback
    });

    it('PERCLOS moderado (abaixo do warn) + bocejo soma mais que qualquer um sozinho', () => {
        const perclosOnly = fuseSignals({ ...QUIET, perclos: 0.20 }, THRESHOLDS);
        const withYawn = fuseSignals({ ...QUIET, perclos: 0.20, yawnActive: true }, THRESHOLDS);
        expect(perclosOnly.state).toBe('NORMAL'); // abaixo de perclosWarn, nenhuma regra forte
        expect(withYawn.warningScore).toBeGreaterThan(perclosOnly.warningScore);
    });

    it('rosto ausente tem peso baixo e sozinho não gera warning (mas dispara a regra forte FACE_LOST diretamente hoje)', () => {
        // faceLost é regra forte na cadeia (prioridade 4) — dispara WARNING
        // por si só, sem precisar do fallback. Isso é comportamento
        // preservado da cadeia original, não do scoring contínuo.
        const f = fuseSignals({ ...QUIET, faceLost: true }, THRESHOLDS);
        expect(f.primaryReason).toBe('FACE_LOST');
    });

    it('scores contínuos ficam limitados (cap 1.5) mesmo com tudo no máximo', () => {
        const everything: FusionInputs = {
            perclos: 1.0, yawnActive: true, headDropped: true, faceLost: true,
            closedForMs: 5000, microsleepForMs: 5000, microsleepMeetsThreshold: true,
            earTrendFraction: 0.9, slowBlinksActive: true, mlScore: 1.0, mode: 'hybrid',
        };
        const f = fuseSignals(everything, THRESHOLDS);
        expect(f.warningScore).toBeLessThanOrEqual(1.5);
        expect(f.alarmScore).toBeLessThanOrEqual(1.5);
    });

    it('PERCLOS crescente nunca diminui o warningScore (monotonicidade)', () => {
        let last = -Infinity;
        for (const p of [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
            const f = fuseSignals({ ...QUIET, perclos: p }, THRESHOLDS);
            expect(f.warningScore).toBeGreaterThanOrEqual(last);
            last = f.warningScore;
        }
    });
});

describe('fuseSignals — ML corroborativo (política preservada de mlReasons.ts)', () => {
    it('modo rules ignora o ML completamente, mesmo com score máximo', () => {
        const f = fuseSignals({ ...QUIET, mlScore: 0.99, mode: 'rules' }, THRESHOLDS);
        expect(f.state).toBe('NORMAL');
        expect(f.primaryReason).toBeNull();
    });

    it('modo hybrid: ML >= mlWarnThreshold sem nenhuma regra → ML_WARNING', () => {
        const f = fuseSignals({ ...QUIET, mlScore: 0.90, mode: 'hybrid' }, THRESHOLDS);
        expect(f.state).toBe('WARNING');
        expect(f.primaryReason).toBe('ML_WARNING');
    });

    it('modo hybrid: ML >= mlAlarmThreshold SEM regra de aviso fisiológica NÃO alarma (não corroborado)', () => {
        const f = fuseSignals({ ...QUIET, mlScore: 0.99, mode: 'hybrid' }, THRESHOLDS);
        expect(f.state).not.toBe('ALARM');
    });

    it('modo hybrid: ML >= mlAlarmThreshold COM regra de aviso fisiológica → ML_ALARM', () => {
        const f = fuseSignals({ ...QUIET, mlScore: 0.99, yawnActive: true, mode: 'hybrid' }, THRESHOLDS);
        expect(f.state).toBe('ALARM');
        expect(f.primaryReason).toBe('ML_ALARM');
    });

    it('FACE_LOST não conta como corroboração para ML_ALARM', () => {
        const f = fuseSignals({ ...QUIET, mlScore: 0.99, faceLost: true, mode: 'hybrid' }, THRESHOLDS);
        expect(f.state).not.toBe('ALARM');
    });

    it('ML indisponível (null): regras continuam funcionando normalmente', () => {
        const f = fuseSignals({ ...QUIET, closedForMs: 1500, mlScore: null, mode: 'hybrid' }, THRESHOLDS);
        expect(f.state).toBe('ALARM');
        expect(f.primaryReason).toBe('EYES_CLOSED_DURATION');
    });
});

describe('fuseSignals — explicabilidade (contributingSignals)', () => {
    it('lista todos os sinais ativos, não só o vencedor', () => {
        const f = fuseSignals(
            { ...QUIET, microsleepMeetsThreshold: true, perclos: 0.50, yawnActive: true },
            THRESHOLDS,
        );
        expect(f.primaryReason).toBe('MICROSLEEP');
        expect(f.contributingSignals).toContain('MICROSLEEP');
        expect(f.contributingSignals).toContain('PERCLOS_CRITICAL');
        expect(f.contributingSignals).toContain('YAWN');
    });
});
