import { wsClient, EventType, type WebSocketMessage } from '../websocket/socketClient';
import { roleStore } from './roleStore';
import { metricsStore } from '../detection/metricsStore';
import { DEFAULT_METRICS } from '../detection/detectionEngine';
import { sessionStats, type SessionSnapshot, type HistoryPoint } from '../detection/sessionStats';
import { calibrationManager } from '../safety/calibrationManager';
import { userModelStore } from '../ml/userModel/userModelStore';
import { calibrationProgress } from './calibrationProgress';

/**
 * Sincronização multi-dispositivo.
 *
 *  - O device que inicia a câmera reivindica o papel de DETECTOR (claim aceito
 *    pelo backend; se já existe detector este device vira VIEWER).
 *  - O DETECTOR publica métricas derivadas + sessão + progresso de calibração
 *    + calibração final + modelo ML. Frames de vídeo NUNCA saem do device.
 *  - VIEWERS aplicam os dados recebidos nos stores locais — todos os
 *    dispositivos passam a ver o mesmo estado ao vivo.
 */

const METRICS_PUBLISH_INTERVAL_MS = 300;
const SESSION_PUBLISH_INTERVAL_MS = 1000;
const HISTORY_TAIL_POINTS = 12;

let started = false;
let publishTimer: ReturnType<typeof setInterval> | null = null;
let sessionTimer: ReturnType<typeof setInterval> | null = null;
let lastCalibrationPublished: number | null = null;
let lastModelPublished: number | null = null;
let lastProgressPublishedAt = 0;
let lastProgressKey = '';

function isDetector(): boolean {
    return roleStore.getRole() === 'detector' && roleStore.getDetectorOwner() === wsClient.getSessionId();
}

// ---------- publicação (detector) ----------

function publishMetrics(): void {
    const m = metricsStore.get();
    if (!m) return;
    wsClient.sendEvent(EventType.METRICS_UPDATE, {
        metrics: { ...m, ear: Number(m.ear.toFixed(4)) },
    });
}

function tail(history: HistoryPoint[]): HistoryPoint[] {
    if (history.length <= HISTORY_TAIL_POINTS) return history;
    return history.slice(history.length - HISTORY_TAIL_POINTS);
}

function publishSession(): void {
    const snap = sessionStats.snapshot(Date.now(), 0);
    const slim: SessionSnapshot = { ...snap, history: tail(snap.history) };
    wsClient.sendEvent(EventType.SESSION_SYNC, { session: slim });
}

/** Progresso de calibração ao vivo (throttled a 300ms, apenas com mudanças). */
function publishCalibrationProgress(): void {
    const now = Date.now();
    if (now - lastProgressPublishedAt < METRICS_PUBLISH_INTERVAL_MS) return;
    const isCal = calibrationManager.isCalibrating;
    const outcome = calibrationManager.getOutcome();
    const key = `${isCal}|${calibrationManager.phase}|${calibrationManager.getOpenSampleCount()}|${calibrationManager.getClosedSampleCount()}|${outcome}`;
    if (!isCal && outcome === null && key === lastProgressKey) return;
    lastProgressKey = key;
    lastProgressPublishedAt = now;
    wsClient.sendEvent(EventType.CALIBRATION_PROGRESS, {
        isCalibrating: isCal,
        phase: calibrationManager.phase === 'closed' ? 'closed' : 'open',
        openCount: calibrationManager.getOpenSampleCount(),
        closedCount: calibrationManager.getClosedSampleCount(),
        outcome,
    });
}

function publishCalibrationResult(): void {
    const at = calibrationManager.getCalibratedAt();
    if (at === lastCalibrationPublished) return;
    lastCalibrationPublished = at;
    wsClient.sendEvent(EventType.CALIBRATION_SYNC, {
        calibration: {
            baselineEar: calibrationManager.getBaseline(),
            closedBaselineEar: calibrationManager.getClosedBaseline(),
            threshold: calibrationManager.getThreshold(),
            baselineNoseDrop: calibrationManager.getBaselineNoseDrop(),
            calibratedAt: at,
            skipped: calibrationManager.isSkipped(),
        },
    });
}

function publishModel(): void {
    const model = userModelStore.getModel();
    if (!model || model.trainedAt === lastModelPublished) return;
    lastModelPublished = model.trainedAt;
    wsClient.sendEvent(EventType.MODEL_SYNC, { model });
}

function stopPublishing(): void {
    if (publishTimer) { clearInterval(publishTimer); publishTimer = null; }
    if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
}

function startPublishing(): void {
    stopPublishing();
    publishTimer = setInterval(() => {
        if (!isDetector()) return;
        publishMetrics();
        publishCalibrationProgress();
        publishCalibrationResult();
        publishModel();
    }, METRICS_PUBLISH_INTERVAL_MS);
    sessionTimer = setInterval(() => {
        if (!isDetector()) return;
        publishSession();
    }, SESSION_PUBLISH_INTERVAL_MS);
}

/**
 * Requisita o papel de detector e aguarda a resposta do backend.
 *  - 'detector': claim aceito (este device monitora)
 *  - 'viewer': outro device já é detector
 *  - 'standalone': WebSocket indisponível — opera localmente sozinho
 */
export function claimDetectorWithResponse(timeoutMs = 3000): Promise<'detector' | 'viewer' | 'standalone'> {
    return new Promise((resolve) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let unsubStatus: (() => void) | null = null;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (unsubStatus) unsubStatus();
            wsClient.off(EventType.DETECTOR_ASSIGNED, onAssigned);
            wsClient.off(EventType.DETECTOR_TAKEN, onTaken);
        };
        const onAssigned = () => {
            if (!done) { done = true; cleanup(); resolve('detector'); }
        };
        const onTaken = () => {
            if (!done) { done = true; cleanup(); resolve('viewer'); }
        };
        const finish = (result: 'detector' | 'viewer' | 'standalone') => {
            if (!done) { done = true; cleanup(); resolve(result); }
        };
        timer = setTimeout(() => finish('standalone'), timeoutMs);
        wsClient.on(EventType.DETECTOR_ASSIGNED, onAssigned);
        wsClient.on(EventType.DETECTOR_TAKEN, onTaken);

        if (wsClient.status === 'CONNECTED') {
            wsClient.sendEvent(EventType.DETECTOR_CLAIM, {});
        } else if (wsClient.status === 'DISCONNECTED' || wsClient.status === 'ERROR') {
            // WebSocket nunca se conectou (backend fora/sem rede): opera local.
            finish('standalone');
        } else {
            // CONNECTING/RECONNECTING: espera abrir e então reivindica.
            const handler = (status: unknown) => {
                if (status === 'CONNECTED') {
                    wsClient.off('status', handler);
                    wsClient.sendEvent(EventType.DETECTOR_CLAIM, {});
                } else if (status === 'ERROR' || status === 'DISCONNECTED') {
                    wsClient.off('status', handler);
                    finish('standalone');
                }
            };
            unsubStatus = () => wsClient.off('status', handler);
            wsClient.on('status', handler);
        }
    });
}

/** Abre mão do papel de detector (câmera parada) liberando para outros devices. */
export function releaseDetector(): void {
    if (isDetector()) {
        wsClient.sendEvent(EventType.DETECTOR_RELEASE, {});
    }
    roleStore.setRole('none');
    roleStore.setDetectorOwner(null);
    stopPublishing();
    lastCalibrationPublished = null;
    lastModelPublished = null;
    lastProgressKey = '';
}

/** Viewer pede ao detector para iniciar (ou cancelar) uma calibração na câmera. */
export function requestRemoteCalibration(action: 'start' | 'cancel' = 'start'): void {
    wsClient.sendEvent(EventType.CALIBRATION_REQUEST, { action });
}

// Callback disparado no detector quando um viewer pede calibração.
type RemoteCalibrationCallback = (action: 'start' | 'cancel') => void;
let remoteCalibrationRequestCb: RemoteCalibrationCallback | null = null;

export function onRemoteCalibrationRequested(cb: RemoteCalibrationCallback | null): () => void {
    remoteCalibrationRequestCb = cb;
    return () => { if (remoteCalibrationRequestCb === cb) remoteCalibrationRequestCb = null; };
}

// ---------- aplicação (viewer) ----------

function applyRemoteMetrics(payload: any): void {
    const metrics = payload?.metrics;
    if (metrics) {
        metricsStore.publish({ ...DEFAULT_METRICS, ...metrics });
    }
}

function applyRemoteSession(payload: any): void {
    const session = payload?.session;
    if (session) {
        sessionStats.applyRemote(session as SessionSnapshot);
    }
}

function applyRemoteCalibrationProgress(payload: any): void {
    calibrationProgress.receive(
        !!payload?.isCalibrating,
        payload?.phase === 'closed' ? 'closed' : 'open',
        Number(payload?.openCount) || 0,
        Number(payload?.closedCount) || 0,
        typeof payload?.outcome === 'string' ? payload.outcome : null,
    );
}

function applyRemoteCalibrationResult(payload: any): void {
    const cal = payload?.calibration;
    if (!cal) return;
    calibrationManager.applyRemoteCalibration(cal);
    // Não limpa o outcome aqui: o viewer em progresso ainda precisa exibir a
    // tela de sucesso. O outcome zera quando a próxima calibração iniciar
    // (o detector reseta lastOutcome em startCalibration).
}

function applyRemoteModel(payload: any): void {
    const model = payload?.model;
    if (model) {
        userModelStore.applyRemoteModel(model);
    }
}

function applySnapshot(payload: any): void {
    if (!payload) return;
    if (payload.has_detector && roleStore.getRole() === 'none') {
        roleStore.setRole('viewer');
        roleStore.setDetectorOwner(payload.detector ?? null);
    }
    // Os valores persistidos pelo backend são os payloads originais dos eventos
    // (ex: payload de METRICS_UPDATE = { metrics: {...} }), então basta
    // reaplicá-los diretamente nos handlers existentes.
    if (payload.metrics) applyRemoteMetrics(payload.metrics);
    if (payload.session) applyRemoteSession(payload.session);
    if (payload.calibration) applyRemoteCalibrationResult(payload.calibration);
    if (payload.user_model) applyRemoteModel(payload.user_model);
}

// ---------- wiring ----------

export function initMultiDeviceSync(): void {
    if (started) return;
    started = true;

    wsClient.on(EventType.DETECTOR_ASSIGNED, () => {
        roleStore.setRole('detector');
        roleStore.setDetectorOwner(wsClient.getSessionId());
        startPublishing();
    });

    wsClient.on(EventType.DETECTOR_TAKEN, (payload: any) => {
        if (roleStore.getRole() !== 'detector') {
            roleStore.setRole('viewer');
            roleStore.setDetectorOwner(payload?.owner ?? null);
            stopPublishing();
        }
    });

    wsClient.on(EventType.DETECTOR_CLEARED, () => {
        roleStore.setDetectorOwner(null);
        if (roleStore.getRole() === 'viewer') {
            roleStore.setRole('none');
        }
        calibrationProgress.clear();
    });

    wsClient.on('message', (msg: WebSocketMessage) => {
        // O detector trata pedidos de calibração vindos de viewers.
        if (msg.type === EventType.CALIBRATION_REQUEST) {
            if (isDetector() && remoteCalibrationRequestCb) {
                const action = msg.payload?.action === 'cancel' ? 'cancel' : 'start';
                remoteCalibrationRequestCb(action);
            }
            return;
        }

        if (isDetector()) return; // detector não consome os próprios broadcasts
        switch (msg.type) {
            case EventType.METRICS_UPDATE:
                applyRemoteMetrics(msg.payload);
                break;
            case EventType.SESSION_SYNC:
                applyRemoteSession(msg.payload);
                break;
            case EventType.CALIBRATION_PROGRESS:
                applyRemoteCalibrationProgress(msg.payload);
                break;
            case EventType.CALIBRATION_SYNC:
                applyRemoteCalibrationResult(msg.payload);
                break;
            case EventType.MODEL_SYNC:
                applyRemoteModel(msg.payload);
                break;
            case EventType.STATE_SNAPSHOT:
                applySnapshot(msg.payload);
                break;
        }
    });
}
