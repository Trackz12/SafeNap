import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { wsClient, EventType } from '../websocket/socketClient';
import { initMultiDeviceSync, claimDetectorWithResponse, releaseDetector } from './multiDeviceSync';
import { roleStore } from './roleStore';
import { metricsStore } from '../detection/metricsStore';
import { DEFAULT_METRICS } from '../detection/detectionEngine';
import { calibrationProgress } from './calibrationProgress';
import { calibrationManager } from '../safety/calibrationManager';
import { userModelStore } from '../ml/userModel/userModelStore';

// Simula uma mensagem recebida do servidor (mimica do wsClient.onmessage real:
// dispara o evento 'message' e, depois, o evento tipado).
function recv(type: string, payload: unknown) {
    const trigger = (wsClient as unknown as { triggerListener: (e: string, d: unknown) => void }).triggerListener.bind(wsClient);
    trigger('message', { type, timestamp: 1, session_id: 'remote', payload });
    trigger(type, payload);
}

beforeEach(() => {
    localStore._store.clear();
    roleStore.setRole('none');
    roleStore.setDetectorOwner(null);
    calibrationManager.cancelCalibration();
    calibrationManager.clearCalibration();
    userModelStore.clearModel();
    calibrationProgress.clear();
    // Simula WebSocket conectado para testar os fluxos de claim/response.
    wsClient.status = 'CONNECTED';
    initMultiDeviceSync();
});

afterEach(() => {
    wsClient.status = 'DISCONNECTED';
});

describe('multiDeviceSync - negociação de papel', () => {
    it('DETECTOR_ASSIGNED torna este device detector', () => {
        recv(EventType.DETECTOR_ASSIGNED, { owner: wsClient.getSessionId() });
        expect(roleStore.getRole()).toBe('detector');
        expect(roleStore.getDetectorOwner()).toBe(wsClient.getSessionId());
    });

    it('DETECTOR_TAKEN torna este device viewer (se não for detector)', () => {
        recv(EventType.DETECTOR_TAKEN, { owner: 'other-device' });
        expect(roleStore.getRole()).toBe('viewer');
        expect(roleStore.getDetectorOwner()).toBe('other-device');
    });

    it('DETECTOR_TAKEN não derruba um detector já ativo', () => {
        recv(EventType.DETECTOR_ASSIGNED, { owner: wsClient.getSessionId() });
        recv(EventType.DETECTOR_TAKEN, { owner: 'other-device' });
        expect(roleStore.getRole()).toBe('detector');
    });

    it('DETECTOR_CLEARED devolve viewer para nenhum papel', () => {
        recv(EventType.DETECTOR_TAKEN, { owner: 'other-device' });
        expect(roleStore.getRole()).toBe('viewer');
        recv(EventType.DETECTOR_CLEARED, {});
        expect(roleStore.getRole()).toBe('none');
        expect(roleStore.getDetectorOwner()).toBeNull();
    });

    it('claimDetectorWithResponse resolve viewer quando ocupado e detector quando aceito', async () => {
        const send = vi.spyOn(wsClient, 'sendEvent').mockImplementation(() => {
            recv(EventType.DETECTOR_TAKEN, { owner: 'busy' });
        });
        const asViewer = await claimDetectorWithResponse(200);
        expect(asViewer).toBe('viewer');
        expect(send).toHaveBeenCalledWith(EventType.DETECTOR_CLAIM, {});
        send.mockRestore();

        roleStore.setRole('none');
        roleStore.setDetectorOwner(null);
        const send2 = vi.spyOn(wsClient, 'sendEvent').mockImplementation(() => {
            recv(EventType.DETECTOR_ASSIGNED, { owner: wsClient.getSessionId() });
        });
        const asDetector = await claimDetectorWithResponse(200);
        expect(asDetector).toBe('detector');
        send2.mockRestore();
    });

    it('claimDetectorWithResponse resolve standalone quando backend retornou erro de conexão', async () => {
        roleStore.setRole('none');
        roleStore.setDetectorOwner(null);
        wsClient.status = 'ERROR';
        const result = await claimDetectorWithResponse(150);
        expect(result).toBe('standalone');
        wsClient.status = 'CONNECTED';
    });

    it('claimDetectorWithResponse aguarda conexão quando DISCONNECTED e resolve detector', async () => {
        roleStore.setRole('none');
        roleStore.setDetectorOwner(null);
        wsClient.status = 'DISCONNECTED';
        const send = vi.spyOn(wsClient, 'sendEvent').mockImplementation(() => {
            recv(EventType.DETECTOR_ASSIGNED, { owner: wsClient.getSessionId() });
        });
        const connectSpy = vi.spyOn(wsClient, 'connect').mockImplementation(() => {
            wsClient.status = 'CONNECTED';
            (wsClient as unknown as { triggerListener: (e: string, d: unknown) => void })
                .triggerListener('status', 'CONNECTED');
        });
        const result = await claimDetectorWithResponse(2000);
        expect(result).toBe('detector');
        expect(connectSpy).toHaveBeenCalled();
        send.mockRestore();
        connectSpy.mockRestore();
    });

    it('releaseDetector limpa papel', () => {
        recv(EventType.DETECTOR_TAKEN, { owner: 'other' });
        expect(roleStore.getRole()).toBe('viewer');
        releaseDetector();
        expect(roleStore.getRole()).toBe('none');
        expect(roleStore.getDetectorOwner()).toBeNull();
    });
});

describe('multiDeviceSync - viewer aplica métricas do detector', () => {
    it('METRICS_UPDATE atualiza a metricsStore local', () => {
        recv(EventType.DETECTOR_TAKEN, { owner: 'other-device' });
        recv(EventType.METRICS_UPDATE, {
            metrics: { ...DEFAULT_METRICS, ear: 0.19, state: 'WARNING', perclos: 0.31 },
        });
        const m = metricsStore.get();
        expect(m?.ear).toBeCloseTo(0.19, 3);
        expect(m?.state).toBe('WARNING');
        expect(m?.perclos).toBeCloseTo(0.31, 3);
    });

    it('detector ignora METRICS_UPDATE de si mesmo', () => {
        recv(EventType.DETECTOR_ASSIGNED, { owner: wsClient.getSessionId() });
        metricsStore.publish({ ...DEFAULT_METRICS, ear: 0.33 });
        // O mesmo device não deve sobrescrever com um eco.
        recv(EventType.METRICS_UPDATE, { metrics: { ...DEFAULT_METRICS, ear: 0.05, state: 'ALARM' } });
        // isDetector() compara owner com o sessionId local; o dono é este device.
        const m = metricsStore.get();
        expect(m?.ear).toBeCloseTo(0.33, 3);
    });

    it('CALIBRATION_PROGRESS atualiza o progresso em tempo real', () => {
        recv(EventType.DETECTOR_TAKEN, { owner: 'other-device' });
        recv(EventType.CALIBRATION_PROGRESS, {
            isCalibrating: true, phase: 'closed', openCount: 20, closedCount: 8, outcome: null,
        });
        const p = calibrationProgress.get();
        expect(p.isCalibrating).toBe(true);
        expect(p.phase).toBe('closed');
        expect(p.openCount).toBe(20);
        expect(p.closedCount).toBe(8);
    });

    it('CALIBRATION_SYNC aplica a calibração final e libera avaliação', () => {
        expect(calibrationManager.canEvaluate()).toBe(false);
        recv(EventType.DETECTOR_TAKEN, { owner: 'other-device' });
        recv(EventType.CALIBRATION_SYNC, {
            calibration: {
                baselineEar: 0.30, closedBaselineEar: 0.14, threshold: 0.22,
                baselineNoseDrop: 0.01, calibratedAt: Date.now(), skipped: false,
            },
        });
        expect(calibrationManager.isCalibrated()).toBe(true);
        expect(calibrationManager.canEvaluate()).toBe(true);
        expect(calibrationManager.getThreshold()).toBeCloseTo(0.22, 3);
    });

    it('MODEL_SYNC adota o modelo do detector', () => {
        recv(EventType.DETECTOR_TAKEN, { owner: 'other-device' });
        recv(EventType.MODEL_SYNC, {
            model: { version: 1, trees: [{ featureIndex: 0, threshold: 0.2, prediction: 1 }], trainedAt: 999, sampleCount: 120 },
        });
        expect(userModelStore.getModel()).not.toBeNull();
        expect(userModelStore.getModel()!.trainedAt).toBe(999);
    });
});
