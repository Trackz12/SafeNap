import { EventType, wsClient } from '../websocket/socketClient';
import { calibrationManager } from '../safety/calibrationManager';
import { sessionStats } from './sessionStats';
import { metricsStore } from './metricsStore';
import type { FrameAnalysis } from '../vision/frameAnalyzer';
import { featureExtractor, type FeatureVector } from './featureExtractor';
import { drowsinessModel } from '../ml/drowsinessModel';
import { mlDataCollector } from '../ml/mlDataCollector';
import { ML_STALE_MS } from '../ml/thresholds';
import { combineWarningReason, combineAlarmReason, type DetectionMode } from '../ml/mlReasons';

export type DetectionState = 'NORMAL' | 'WARNING' | 'ALARM';
export type PresetName = 'lenient' | 'standard' | 'strict';
export type AlarmReason = 'EYES_CLOSED_DURATION' | 'PERCLOS_CRITICAL' | 'ML_ALARM';
export type WarningReason = 'PERCLOS' | 'YAWN' | 'HEAD_DROP' | 'FACE_LOST' | 'PROLONGED_CLOSE' | 'ML_WARNING';

export interface DetectionMetrics {
    state: DetectionState;
    reason: AlarmReason | WarningReason | null;
    facePresent: boolean;
    faceLostForMs: number;
    eyesClosed: boolean;
    closedForMs: number;
    ear: number;
    perclos: number;
    blinkRate: number;
    mouthAspect: number;
    yawnActive: boolean;
    noseDropRatio: number;
    headDropped: boolean;
    threshold: number;
    preset: PresetName;
    mlScore: number | null;
}

interface DetectionConfig {
    drowsinessThresholdMs: number;
    perclosWindowMs: number;
    perclosWarningLevel: number;
    perclosAlarmLevel: number;
    perclosReleaseLevel: number;
    warnCloseMs: number;
    hysteresisFactor: number;
    faceLostWarnMs: number;
    minBlinkMs: number;
    maxBlinkMs: number;
    yawnMouthAspect: number;
    yawnMinMs: number;
    yawnCooldownMs: number;
    headDropMargin: number;
    headDropMinMs: number;
    closeConfirmFrames: number;
    perclosIgnoreMs: number;
}

const PRESETS: Record<PresetName, DetectionConfig> = {
    lenient: {
        drowsinessThresholdMs: 2000,
        perclosWindowMs: 60000,
        perclosWarningLevel: 0.30,
        perclosAlarmLevel: 0.55,
        perclosReleaseLevel: 0.20,
        warnCloseMs: 800,
        hysteresisFactor: 1.15,
        faceLostWarnMs: 5000,
        minBlinkMs: 50,
        maxBlinkMs: 400,
        yawnMouthAspect: 0.70,
        yawnMinMs: 400,
        yawnCooldownMs: 10000,
        headDropMargin: 0.08,
        headDropMinMs: 2500,
        closeConfirmFrames: 4,
        perclosIgnoreMs: 400,
    },
    standard: {
        drowsinessThresholdMs: 1500,
        perclosWindowMs: 60000,
        perclosWarningLevel: 0.25,
        perclosAlarmLevel: 0.45,
        perclosReleaseLevel: 0.15,
        warnCloseMs: 700,
        hysteresisFactor: 1.15,
        faceLostWarnMs: 5000,
        minBlinkMs: 50,
        maxBlinkMs: 400,
        yawnMouthAspect: 0.65,
        yawnMinMs: 400,
        yawnCooldownMs: 10000,
        headDropMargin: 0.07,
        headDropMinMs: 2000,
        closeConfirmFrames: 3,
        perclosIgnoreMs: 400,
    },
    strict: {
        drowsinessThresholdMs: 1000,
        perclosWindowMs: 60000,
        perclosWarningLevel: 0.20,
        perclosAlarmLevel: 0.38,
        perclosReleaseLevel: 0.12,
        warnCloseMs: 500,
        hysteresisFactor: 1.20,
        faceLostWarnMs: 4000,
        minBlinkMs: 50,
        maxBlinkMs: 400,
        yawnMouthAspect: 0.60,
        yawnMinMs: 350,
        yawnCooldownMs: 8000,
        headDropMargin: 0.05,
        headDropMinMs: 1500,
        closeConfirmFrames: 2,
        perclosIgnoreMs: 400,
    },
};

export const DEFAULT_METRICS: DetectionMetrics = {
    state: 'NORMAL',
    reason: null,
    facePresent: false,
    faceLostForMs: 0,
    eyesClosed: false,
    closedForMs: 0,
    ear: 0,
    perclos: 0,
    blinkRate: 0,
    mouthAspect: 0,
    yawnActive: false,
    noseDropRatio: 0,
    headDropped: false,
    threshold: calibrationManager.getThreshold(),
    preset: 'standard',
    mlScore: null,
};

interface ClosedSegment {
    start: number;
    end: number;
}

// Janela do filtro de mediana aplicado ao EAR (em frames). 3 elimina picos
// isolados de jitter mantendo resposta rápida a fechamento real (~200ms).
const EAR_SMOOTHING_WINDOW = 3;

export class DetectionEngine {
    private state: DetectionState = 'NORMAL';
    private reason: AlarmReason | WarningReason | null = null;
    private config: DetectionConfig = { ...PRESETS.standard };
    private presetName: PresetName = 'standard';

    private eyesClosed = false;
    private closedSince: number | null = null;
    private segments: ClosedSegment[] = [];
    private blinkTimestamps: number[] = [];

    private facePresent = false;
    private faceLostSince: number | null = null;
    private faceLostReported = false;

    private yawnSince: number | null = null;
    private yawnActive = false;
    private lastYawnEventAt = -Infinity;

    private headDropSince: number | null = null;
    private headDropped = false;

    // Filtro de mediana (janela 3) no EAR: mata picos de jitter isolados do
    // MediaPipe sem o atraso médio de um EMA. Soma-se à confirmação por N
    // frames abaixo do threshold para eliminar falsos positivos de 1 frame.
    private earBuffer: number[] = [];
    private belowThresholdStreak = 0;
    private closedCandidateSince: number | null = null;

    private startedAt: number | null = null;
    private lastHeartbeatAt = 0;

    private lastFeatureVector: FeatureVector | null = null;
    private detectionMode: DetectionMode = 'hybrid';
    private lastMlScore: number | null = null;

    private heartbeatIfAlarm(now: number): void {
        if (this.state === 'ALARM' && now - this.lastHeartbeatAt >= 3000) {
            this.lastHeartbeatAt = now;
            wsClient.sendEvent(EventType.HEARTBEAT, { state: this.state });
        }
    }

    /** Mediana da janela dos últimos N EAR — remove picos de jitter. */
    private smoothEar(raw: number): number {
        this.earBuffer.push(raw);
        if (this.earBuffer.length > EAR_SMOOTHING_WINDOW) {
            this.earBuffer.shift();
        }
        const sorted = [...this.earBuffer].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2
            ? sorted[mid]
            : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    public setPreset(name: PresetName): void {
        this.presetName = name;
        this.config = { ...PRESETS[name] };
    }

    public getPreset(): PresetName {
        return this.presetName;
    }

    public getState(): DetectionState {
        return this.state;
    }

    public getLastBlinkAt(): number | null {
        return this.blinkTimestamps.length > 0
            ? this.blinkTimestamps[this.blinkTimestamps.length - 1]
            : null;
    }

    public getLastFeatureVector(): FeatureVector | null {
        return this.lastFeatureVector;
    }

    public setMode(mode: DetectionMode): void {
        this.detectionMode = mode;
    }

    public getMode(): DetectionMode {
        return this.detectionMode;
    }

    public reset(): void {
        this.state = 'NORMAL';
        this.reason = null;
        this.eyesClosed = false;
        this.closedSince = null;
        this.segments = [];
        this.blinkTimestamps = [];
        this.facePresent = false;
        this.faceLostSince = null;
        this.faceLostReported = false;
        this.yawnSince = null;
        this.yawnActive = false;
        this.lastYawnEventAt = -Infinity;
        this.headDropSince = null;
        this.headDropped = false;
        this.earBuffer = [];
        this.belowThresholdStreak = 0;
        this.closedCandidateSince = null;
        this.startedAt = null;
        this.lastFeatureVector = null;
        this.lastMlScore = null;
        featureExtractor.reset();
        drowsinessModel.reset();
    }

    public ackAlarm(): void {
        this.segments = [];
        this.blinkTimestamps = [];
        this.eyesClosed = false;
        this.closedSince = null;
        this.state = 'NORMAL';
        this.reason = null;
        this.lastFeatureVector = null;
        this.lastMlScore = null;
        featureExtractor.reset();
        drowsinessModel.reset();
        sessionStats.reset();
        wsClient.sendEvent(EventType.ALARM_ACKNOWLEDGED);
        this.publishLastFrame(DEFAULT_METRICS);
    }

    public processNoFace(): void {
        const now = Date.now();
        this.sessionStart(now);
        sessionStats.markStarted(now);

        this.facePresent = false;
        if (this.faceLostSince === null) {
            this.faceLostSince = now;
        }
        if (this.eyesClosed && this.closedSince !== null) {
            this.segments.push({ start: this.closedSince, end: now });
            this.eyesClosed = false;
            this.closedSince = null;
        }
        this.belowThresholdStreak = 0;
        this.closedCandidateSince = null;
        this.earBuffer = [];
        this.lastFeatureVector = null;
        featureExtractor.reset();
        drowsinessModel.reset();
        const lostFor = now - this.faceLostSince;
        if (!this.faceLostReported && lostFor >= this.config.faceLostWarnMs) {
            this.faceLostReported = true;
            wsClient.sendEvent(EventType.FACE_LOST, { lostForMs: lostFor });
        }

        if (this.state !== 'ALARM' && !calibrationManager.isCalibrating && calibrationManager.canEvaluate()) {
            this.evaluate(now, 0, lostFor);
        }

        const perclos = this.perclosAt(now);
        sessionStats.sample(now, 0, perclos, this.state);
        this.heartbeatIfAlarm(now);

        metricsStore.publish({
            ...DEFAULT_METRICS,
            state: this.state,
            reason: this.reason,
            facePresent: false,
            faceLostForMs: lostFor,
            perclos,
            blinkRate: this.blinkRateAt(now),
            threshold: calibrationManager.getThreshold(),
            preset: this.presetName,
        });
    }

    public processFrame(frame: FrameAnalysis): void {
        const now = Date.now();
        this.sessionStart(now);
        sessionStats.markStarted(now);

        // Filtro de mediana no EAR: remove picos de jitter de 1 frame.
        const rawEar = frame.ear;
        const ear = this.smoothEar(rawEar);
        sessionStats.addEar(ear);

        if (!this.facePresent) {
            this.facePresent = true;
            this.faceLostSince = null;
            this.faceLostReported = false;
            wsClient.sendEvent(EventType.FACE_DETECTED);
        }

        const threshold = calibrationManager.getThreshold();

        // Confirmação por N frames consecutivos abaixo do threshold:
        // um frame ruidoso isolado não dispara mais "olhos fechados".
        const below = ear < threshold;
        if (below) {
            if (this.closedCandidateSince === null) this.closedCandidateSince = now;
            this.belowThresholdStreak++;
        } else {
            this.belowThresholdStreak = 0;
            this.closedCandidateSince = null;
        }

        let closed = this.eyesClosed;
        if (!this.eyesClosed && this.belowThresholdStreak >= this.config.closeConfirmFrames) {
            closed = true;
        } else if (this.eyesClosed && ear > threshold * this.config.hysteresisFactor) {
            closed = false;
        }

        if (closed && !this.eyesClosed) {
            this.eyesClosed = true;
            this.closedSince = this.closedCandidateSince ?? now;
            wsClient.sendEvent(EventType.EYES_CLOSED, { ear });
        } else if (!closed && this.eyesClosed) {
            const closedStart = this.closedSince ?? now;
            const duration = now - closedStart;
            this.segments.push({ start: closedStart, end: now });
            this.eyesClosed = false;
            this.closedSince = null;
            this.belowThresholdStreak = 0;
            this.closedCandidateSince = null;

            if (duration >= this.config.minBlinkMs && duration <= this.config.maxBlinkMs) {
                this.blinkTimestamps.push(now);
                sessionStats.recordBlink(now);
            }
            if (duration >= this.config.drowsinessThresholdMs) {
                sessionStats.recordEpisode(now);
            }
            wsClient.sendEvent(EventType.EYES_OPEN, { ear });
        }

        this.processYawn(frame.mouthAspect, now);
        this.processHeadDrop(frame.noseDropRatio, now);

        if (!calibrationManager.isCalibrating) {
            const closedForMs = this.eyesClosed && this.closedSince !== null
                ? now - this.closedSince
                : 0;
            this.evaluate(now, closedForMs, 0);
        }

        const perclos = this.perclosAt(now);
        const blinkRate = this.blinkRateAt(now);
        this.lastFeatureVector = featureExtractor.extract(frame, now, {
            perclos,
            blinkRate,
            lastBlinkAt: this.getLastBlinkAt(),
        });
        if (this.lastFeatureVector) {
            mlDataCollector.collectFrame(this.lastFeatureVector);
            drowsinessModel.inferAsync(this.lastFeatureVector, now);
        }
        sessionStats.sample(now, ear, perclos, this.state);
        this.heartbeatIfAlarm(now);

        metricsStore.publish({
            state: this.state,
            reason: this.reason,
            facePresent: true,
            faceLostForMs: 0,
            eyesClosed: this.eyesClosed,
            closedForMs: this.eyesClosed && this.closedSince !== null ? now - this.closedSince : 0,
            ear,
            perclos,
            blinkRate,
            mouthAspect: frame.mouthAspect,
            yawnActive: this.yawnActive,
            noseDropRatio: frame.noseDropRatio,
            headDropped: this.headDropped,
            threshold,
            preset: this.presetName,
            mlScore: this.lastMlScore,
        });
    }

    private sessionStart(now: number): void {
        if (this.startedAt === null) this.startedAt = now;
    }

    private perclosAt(now: number): number {
        const windowStart = now - this.config.perclosWindowMs;
        // Ignora segmentos curtos (duração de piscada normal) — só episódios
        // sustentados de olhos fechados devem inflar o PERCLOS.
        this.segments = this.segments.filter(
            (s) => s.end > windowStart && s.end - s.start >= this.config.perclosIgnoreMs
        );
        let closedMs = 0;
        for (const s of this.segments) {
            closedMs += s.end - Math.max(s.start, windowStart);
        }
        if (this.eyesClosed && this.closedSince !== null) {
            closedMs += now - Math.max(this.closedSince, windowStart);
        }
        return Math.min(1, closedMs / this.config.perclosWindowMs);
    }

    private blinkRateAt(now: number): number {
        const windowStart = now - 60000;
        this.blinkTimestamps = this.blinkTimestamps.filter((t) => t > windowStart);
        if (this.startedAt === null) return 0;
        const observedMs = Math.min(60000, Math.max(1, now - this.startedAt));
        return Math.round(this.blinkTimestamps.length / (observedMs / 60000));
    }

    private processYawn(mouthAspect: number, now: number): void {
        if (mouthAspect > this.config.yawnMouthAspect) {
            if (this.yawnSince === null) this.yawnSince = now;
            if (now - this.yawnSince >= this.config.yawnMinMs && !this.yawnActive) {
                this.yawnActive = true;
                this.lastYawnEventAt = now;
                wsClient.sendEvent(EventType.YAWN_DETECTED, { mouthAspect });
            }
        } else {
            this.yawnSince = null;
            if (this.yawnActive && now - this.lastYawnEventAt >= this.config.yawnCooldownMs) {
                this.yawnActive = false;
            }
        }
    }

    private processHeadDrop(noseDropRatio: number, now: number): void {
        const baseline = calibrationManager.getBaselineNoseDrop();
        if (baseline === null) {
            this.headDropped = false;
            this.headDropSince = null;
            return;
        }

        const droppedNow = noseDropRatio > baseline + this.config.headDropMargin;
        if (droppedNow) {
            if (this.headDropSince === null) this.headDropSince = now;
            if (!this.headDropped && now - this.headDropSince >= this.config.headDropMinMs) {
                this.headDropped = true;
                wsClient.sendEvent(EventType.HEAD_DROPPED, { noseDropRatio, baseline });
            }
        } else {
            this.headDropSince = null;
            if (this.headDropped && noseDropRatio < baseline + this.config.headDropMargin * 0.5) {
                this.headDropped = false;
            }
        }
    }

    private evaluate(now: number, closedForMs: number, faceLostForMs: number): void {
        const perclos = this.perclosAt(now);

        // ML score: usar se fresco, senão null (fallback para regras)
        const mlResult = drowsinessModel.getLastScore();
        const mlFresh = mlResult.at !== null && (now - mlResult.at) <= ML_STALE_MS;
        this.lastMlScore = mlFresh ? mlResult.score : null;

        let ruleWarn: WarningReason | null = null;
        if (perclos >= this.config.perclosWarningLevel) ruleWarn = 'PERCLOS';
        else if (this.yawnActive) ruleWarn = 'YAWN';
        else if (this.headDropped) ruleWarn = 'HEAD_DROP';
        else if (this.faceLostReported || faceLostForMs >= this.config.faceLostWarnMs) ruleWarn = 'FACE_LOST';
        else if (closedForMs >= this.config.warnCloseMs) ruleWarn = 'PROLONGED_CLOSE';

        let ruleAlarm: AlarmReason | null = null;
        if (closedForMs >= this.config.drowsinessThresholdMs) ruleAlarm = 'EYES_CLOSED_DURATION';
        else if (perclos >= this.config.perclosAlarmLevel) ruleAlarm = 'PERCLOS_CRITICAL';

        const warnedReason = combineWarningReason(this.detectionMode, ruleWarn, this.lastMlScore);
        const alarmReason = combineAlarmReason(this.detectionMode, ruleAlarm, this.lastMlScore);

        if (this.state === 'ALARM') {
            if (alarmReason === null && !this.eyesClosed && perclos < this.config.perclosReleaseLevel) {
                this.state = warnedReason ? 'WARNING' : 'NORMAL';
                this.reason = warnedReason;
                wsClient.sendEvent(EventType.DROWSINESS_ENDED, { perclos });
                if (warnedReason) {
                    this.emitStateEntry(perclos, warnedReason);
                }
            }
            return;
        }

        if (alarmReason !== null) {
            this.state = 'ALARM';
            this.reason = alarmReason;
            wsClient.sendEvent(EventType.DROWSINESS_STARTED, {
                reason: alarmReason,
                perclos,
                closedForMs,
            });
            return;
        }

        if (warnedReason !== null && this.state === 'NORMAL') {
            this.state = 'WARNING';
            this.reason = warnedReason;
            sessionStats.recordWarning(now);
            this.emitStateEntry(perclos, warnedReason);
            return;
        }

        if (warnedReason === null && this.state === 'WARNING') {
            this.state = 'NORMAL';
            this.reason = null;
            wsClient.sendEvent(EventType.DROWSINESS_WARNING_ENDED, { perclos });
        }
    }

    private emitStateEntry(perclos: number, reason: WarningReason): void {
        wsClient.sendEvent(EventType.DROWSINESS_WARNING, { reason, perclos });
    }

    private publishLastFrame(metrics: DetectionMetrics): void {
        metricsStore.publish(metrics);
    }
}

export const detectionEngine = new DetectionEngine();
