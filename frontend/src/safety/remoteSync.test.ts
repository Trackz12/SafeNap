import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { calibrationManager } from './calibrationManager';
import { sessionStats } from '../detection/sessionStats';
import { userModelStore } from '../ml/userModel/userModelStore';

beforeEach(() => {
    localStore._store.clear();
    calibrationManager.cancelCalibration();
    calibrationManager.clearCalibration();
    sessionStats.reset();
    userModelStore.clearAll();
});

describe('applyRemoteCalibration (viewer recebe calibração do detector)', () => {
    it('aplica baseline e threshold remotos e libera avaliação', () => {
        expect(calibrationManager.canEvaluate()).toBe(false);

        calibrationManager.applyRemoteCalibration({
            baselineEar: 0.31,
            closedBaselineEar: 0.14,
            threshold: 0.23,
            baselineNoseDrop: 0.02,
            calibratedAt: Date.now(),
        });

        expect(calibrationManager.isCalibrated()).toBe(true);
        expect(calibrationManager.canEvaluate()).toBe(true);
        expect(calibrationManager.getBaseline()).toBeCloseTo(0.31, 5);
        expect(calibrationManager.getThreshold()).toBeCloseTo(0.23, 5);
        expect(calibrationManager.getBaselineNoseDrop()).toBeCloseTo(0.02, 5);
    });

    it('ignora payload inválido (mantém estado anterior)', () => {
        calibrationManager.applyRemoteCalibration({
            baselineEar: NaN,
            threshold: 0.23,
            baselineNoseDrop: null,
            calibratedAt: null,
        });
        expect(calibrationManager.isCalibrated()).toBe(false);
        expect(calibrationManager.canEvaluate()).toBe(false);
    });

    it('payload com skipped=true libera avaliação com precisão reduzida', () => {
        calibrationManager.applyRemoteCalibration({
            baselineEar: null,
            threshold: 0.25,
            baselineNoseDrop: null,
            calibratedAt: null,
            skipped: true,
        });
        expect(calibrationManager.canEvaluate()).toBe(true);
        expect(calibrationManager.isCalibrated()).toBe(false);
    });

    it('clamps threshold fora dos limites de sanidade', () => {
        calibrationManager.applyRemoteCalibration({
            baselineEar: 0.9,
            threshold: 0.9,
            baselineNoseDrop: null,
            calibratedAt: Date.now(),
        });
        expect(calibrationManager.getThreshold()).toBeLessThanOrEqual(0.45);
    });
});

describe('sessionStats.applyRemote (viewer espelha sessão do detector)', () => {
    it('espelha contadores e histórico curto', () => {
        const now = Date.now();
        sessionStats.applyRemote({
            active: true,
            durationMs: 30000,
            blinkCount: 12,
            blinkRate: 15,
            episodeCount: 2,
            warningCount: 3,
            avgEar: 0.29,
            drowsyTimeMs: 6000,
            history: [
                { t: now - 2000, ear: 0.3, perclos: 0.05, state: 'NORMAL' },
                { t: now - 1000, ear: 0.28, perclos: 0.10, state: 'WARNING' },
            ],
        });

        expect(sessionStats.snapshot(Date.now(), 0).blinkCount).toBe(12);
        expect(sessionStats.snapshot(Date.now(), 0).episodeCount).toBe(2);
        expect(sessionStats.getHistory().length).toBe(2);
    });

    it('sessão inativa não marca tempo ativo', () => {
        sessionStats.applyRemote({
            active: false,
            durationMs: 0,
            blinkCount: 0,
            blinkRate: 0,
            episodeCount: 0,
            warningCount: 0,
            avgEar: 0,
            drowsyTimeMs: 0,
            history: [],
        });
        expect(sessionStats.snapshot(Date.now(), 0).active).toBe(false);
    });
});

describe('userModelStore.applyRemoteModel (viewer adota o modelo do detector)', () => {
    const dummyModel = {
        version: 1,
        trees: [{ featureIndex: 0, threshold: 0.2, prediction: 1, count: 60 }],
        trainedAt: 1000,
        sampleCount: 120,
    };

    it('adota modelo remoto inexistente localmente', () => {
        userModelStore.applyRemoteModel(dummyModel as never);
        expect(userModelStore.getModel()).not.toBeNull();
        expect(userModelStore.getModel()!.trainedAt).toBe(1000);
    });

    it('não substitui modelo local mais novo', () => {
        userModelStore.applyRemoteModel({ ...dummyModel, trainedAt: 5000 } as never);
        userModelStore.applyRemoteModel({ ...dummyModel, trainedAt: 2000 } as never);
        expect(userModelStore.getModel()!.trainedAt).toBe(5000);
    });
});
