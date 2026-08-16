import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// localStorage fake precisa existir ANTES da importação do módulo
// (o singleton calibrationManager roda loadPersisted() na importação).
const localStore = vi.hoisted(() => {
    const store = new Map<string, string>();
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => store.clear(),
        _store: store,
    };
    vi.stubGlobal('localStorage', api);
    return api;
});

import {
    calibrationManager,
    DEFAULT_THRESHOLD,
    MIN_CALIBRATION_SAMPLES,
    MAX_CALIBRATION_PHASE_MS,
} from './calibrationManager';

const STORAGE_KEY = 'safenap_calibration_v3';

function fillSamples(value: number, count: number): void {
    for (let i = 0; i < count; i++) {
        calibrationManager.addSample(value);
    }
}

beforeEach(() => {
    localStore._store.clear();
    vi.useFakeTimers();
    calibrationManager.settleDelayMs = 0;
    calibrationManager.cancelCalibration();
    calibrationManager.clearCalibration();
});

afterEach(() => {
    calibrationManager.cancelCalibration();
    calibrationManager.clearCalibration();
    vi.useRealTimers();
});

describe('calibrationManager - estado inicial', () => {
    it('sem calibração não pode avaliar (deteção bloqueada)', () => {
        expect(calibrationManager.isCalibrated()).toBe(false);
        expect(calibrationManager.canEvaluate()).toBe(false);
        expect(calibrationManager.getThreshold()).toBe(DEFAULT_THRESHOLD);
        expect(calibrationManager.getOutcome()).toBeNull();
    });

    it('skipWithDefault libera avaliação com precisão reduzida', () => {
        expect(calibrationManager.canEvaluate()).toBe(false);
        calibrationManager.skipWithDefault();
        expect(calibrationManager.canEvaluate()).toBe(true);
        expect(calibrationManager.isSkipped()).toBe(true);
        calibrationManager.clearCalibration();
        expect(calibrationManager.canEvaluate()).toBe(false);
    });
});

describe('calibrationManager - fluxo guiado automático', () => {
    it('avança sozinho para a fase fechada com 20 amostras abertas', () => {
        calibrationManager.startCalibration();
        expect(calibrationManager.phase).toBe('open');

        fillSamples(0.30, MIN_CALIBRATION_SAMPLES);
        expect(calibrationManager.getOpenSampleCount()).toBe(MIN_CALIBRATION_SAMPLES);

        vi.advanceTimersByTime(250);
        expect(calibrationManager.phase).toBe('closed');
        calibrationManager.cancelCalibration();
    });

    it('finaliza com sucesso e calcula threshold como mediana das fases', () => {
        calibrationManager.startCalibration();
        fillSamples(0.30, MIN_CALIBRATION_SAMPLES);
        vi.advanceTimersByTime(250);

        fillSamples(0.15, MIN_CALIBRATION_SAMPLES);
        vi.advanceTimersByTime(250);

        expect(calibrationManager.phase).toBe('idle');
        expect(calibrationManager.isCalibrating).toBe(false);
        expect(calibrationManager.getOutcome()).toBe('ok');
        expect(calibrationManager.getBaseline()).toBeCloseTo(0.30, 5);
        expect(calibrationManager.getClosedBaseline()).toBeCloseTo(0.15, 5);
        expect(calibrationManager.getThreshold()).toBeCloseTo(0.225, 5);
        expect(calibrationManager.isCalibrated()).toBe(true);
        expect(calibrationManager.canEvaluate()).toBe(true);
        expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });

    it('descarta calibração quando a diferença aberta/fechada é mínima (gap)', () => {
        calibrationManager.startCalibration();
        fillSamples(0.30, MIN_CALIBRATION_SAMPLES);
        vi.advanceTimersByTime(250);

        fillSamples(0.28, MIN_CALIBRATION_SAMPLES);
        vi.advanceTimersByTime(250);

        expect(calibrationManager.getOutcome()).toBe('gap');
        expect(calibrationManager.isCalibrated()).toBe(false);
        expect(calibrationManager.canEvaluate()).toBe(false);
    });

    it('aborta com timeout quando nenhuma amostra chega', () => {
        calibrationManager.startCalibration();
        expect(calibrationManager.isCalibrating).toBe(true);

        vi.advanceTimersByTime(MAX_CALIBRATION_PHASE_MS + 300);

        expect(calibrationManager.isCalibrating).toBe(false);
        expect(calibrationManager.getOutcome()).toBe('timeout');
        expect(calibrationManager.isCalibrated()).toBe(false);
    });

    it('timeout também vale para a fase fechada', () => {
        calibrationManager.startCalibration();
        fillSamples(0.30, MIN_CALIBRATION_SAMPLES);
        vi.advanceTimersByTime(250);
        expect(calibrationManager.phase).toBe('closed');

        vi.advanceTimersByTime(MAX_CALIBRATION_PHASE_MS + 300);
        expect(calibrationManager.getOutcome()).toBe('timeout');
    });

    it('cancelamento limpa o estado sem registrar outcome', () => {
        calibrationManager.startCalibration();
        fillSamples(0.30, 5);
        calibrationManager.cancelCalibration();
        vi.advanceTimersByTime(500);

        expect(calibrationManager.isCalibrating).toBe(false);
        expect(calibrationManager.phase).toBe('idle');
        expect(calibrationManager.getOutcome()).toBeNull();
        expect(calibrationManager.getOpenSampleCount()).toBe(0);
    });

    it('ignora amostras não finite ou <= 0', () => {
        calibrationManager.startCalibration();
        calibrationManager.addSample(NaN);
        calibrationManager.addSample(0);
        calibrationManager.addSample(-0.2);
        expect(calibrationManager.getOpenSampleCount()).toBe(0);
        calibrationManager.cancelCalibration();
    });
});

describe('calibrationManager - recalibração sugerida', () => {
    it('isStale só fica verdadeiro após 6h da calibração', () => {
        const now = Date.now();
        calibrationManager.startCalibration();
        fillSamples(0.30, MIN_CALIBRATION_SAMPLES);
        vi.advanceTimersByTime(250);
        fillSamples(0.15, MIN_CALIBRATION_SAMPLES);
        vi.advanceTimersByTime(250);
        expect(calibrationManager.isCalibrated()).toBe(true);
        expect(calibrationManager.isStale()).toBe(false);

        vi.setSystemTime(now + 7 * 60 * 60 * 1000);
        expect(calibrationManager.isStale()).toBe(true);
    });
});
