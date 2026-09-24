import { EventType, wsClient } from '../websocket/socketClient';
import { calibrationManager } from '../safety/calibrationManager';
import { sessionStats } from './sessionStats';
import { metricsStore } from './metricsStore';
import type { FrameAnalysis } from '../vision/frameAnalyzer';
import { featureExtractor, type FeatureVector } from './featureExtractor';
import { drowsinessModel } from '../ml/drowsinessModel';
import { mlDataCollector } from '../ml/mlDataCollector';
import { ML_STALE_MS, ML_STALE_DURING_ALARM_MS, ML_RELEASE_THRESHOLD, ML_WARNING_THRESHOLD, ML_ALARM_THRESHOLD } from '../ml/thresholds';
import { systemClock, type Clock } from './temporal/clock';
import { EyeStateDetector, type EyeState } from './eye/eyeStateDetector';
import { BlinkDetector } from './eye/blinkDetector';
import { PerclosTracker } from './eye/perclosTracker';
import { MicrosleepDetector } from './eye/microsleepDetector';
import { HeadDropDetector } from './head/headDropDetector';
import { YawnDetector } from './mouth/yawnDetector';
import { EarTrendTracker } from './temporal/earTrendTracker';
import type { VisionQuality } from './vision/visionQuality';
import {
    fuseSignals,
    type DetectionState,
    type DetectionMode,
    type WarningReason,
    type AlarmReason,
    type FusionThresholds,
} from './fusion/signalFusion';

export type { DetectionState, DetectionMode, WarningReason, AlarmReason };

export interface DetectionMetrics {
    state: DetectionState;
    reason: AlarmReason | WarningReason | null;
    facePresent: boolean;
    /**
     * Qualidade do sinal de visão neste quadro (auditoria de qualidade,
     * 2026-09-23, achado nº 1). Distingue os três casos que antes eram
     * colapsados em `facePresent: boolean`:
     *   GOOD     — rosto frontal, EAR binocular confiável;
     *   DEGRADED — rosto visível mas o sinal ocular não é confiável (perfil
     *              acentuado, ou geometria rejeitada pelo frameAnalyzer);
     *   LOST     — nenhum rosto detectado.
     * REPORTADO, não usado para ponderar decisão — ver frameAnalyzer.ts.
     */
    visionQuality: VisionQuality;
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

export type PresetName = 'lenient' | 'standard' | 'strict';

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
    /** Abertura de boca mais longa que isto não é bocejo — ver mouth/yawnDetector.ts. */
    yawnMaxMs: number;
    /** Persistência de yawnActive após a boca fechar (anti-flicker). */
    yawnActiveHoldMs: number;
    yawnCooldownMs: number;
    headDropMargin: number;
    headDropMinMs: number;
    /** Tempo abaixo do limiar pra confirmar fechamento — ver eye/eyeStateDetector.ts. */
    closeConfirmMs: number;
    perclosIgnoreMs: number;
    /** Observação válida mínima pro PERCLOS valer na decisão — ver eye/perclosTracker.ts. */
    perclosMinObservationMs: number;
    microsleepThresholdFactor: number;
    microsleepAlarmMs: number;
    microsleepCooldownMs: number;
    earTrendWarnFraction: number;
    earTrendWindowMs: number;
    slowBlinkMinObservationMs: number;
    slowBlinkMinMs: number;
    slowBlinkRateThreshold: number;
    warningReleaseFraction: number;
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
        yawnMaxMs: 7000,
        yawnActiveHoldMs: 2000,
        yawnCooldownMs: 10000,
        headDropMargin: 0.08,
        headDropMinMs: 2500,
        closeConfirmMs: 150,
        perclosIgnoreMs: 400,
        perclosMinObservationMs: 20000,
        microsleepThresholdFactor: 0.55,
        microsleepAlarmMs: 2000,
        microsleepCooldownMs: 12000,
        earTrendWarnFraction: 0.20,
        earTrendWindowMs: 60000,
        slowBlinkMinObservationMs: 30000,
        slowBlinkMinMs: 700,
        slowBlinkRateThreshold: 5,
        warningReleaseFraction: 0.80,
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
        yawnMaxMs: 7000,
        yawnActiveHoldMs: 2000,
        yawnCooldownMs: 10000,
        headDropMargin: 0.07,
        headDropMinMs: 2000,
        closeConfirmMs: 90,
        perclosIgnoreMs: 400,
        perclosMinObservationMs: 20000,
        microsleepThresholdFactor: 0.55,
        microsleepAlarmMs: 1800,
        microsleepCooldownMs: 10000,
        earTrendWarnFraction: 0.18,
        earTrendWindowMs: 60000,
        slowBlinkMinObservationMs: 30000,
        slowBlinkMinMs: 550,
        slowBlinkRateThreshold: 4,
        warningReleaseFraction: 0.80,
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
        yawnMaxMs: 7000,
        yawnActiveHoldMs: 2000,
        yawnCooldownMs: 8000,
        headDropMargin: 0.05,
        headDropMinMs: 1500,
        closeConfirmMs: 60,
        perclosIgnoreMs: 400,
        perclosMinObservationMs: 20000,
        microsleepThresholdFactor: 0.55,
        microsleepAlarmMs: 1500,
        microsleepCooldownMs: 8000,
        earTrendWarnFraction: 0.15,
        earTrendWindowMs: 60000,
        slowBlinkMinObservationMs: 30000,
        slowBlinkMinMs: 450,
        slowBlinkRateThreshold: 3,
        warningReleaseFraction: 0.80,
    },
};

export const DEFAULT_METRICS: DetectionMetrics = {
    state: 'NORMAL',
    reason: null,
    facePresent: false,
    visionQuality: 'LOST',
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
    threshold: 0.25, // fallback; será atualizado por publishLastFrame via calibrationManager.getThreshold()
    preset: 'standard',
    mlScore: null,
};

// Janela do filtro de mediana aplicado ao EAR (em frames). 3 elimina picos
// isolados de jitter mantendo resposta rápida a fechamento real (~200ms).
const EAR_SMOOTHING_WINDOW = 3;
/**
 * Piso de quadros consecutivos para confirmar fechamento/micro-sono.
 *
 * Isto é proteção contra ruído, NÃO unidade de tempo — a duração é medida em
 * ms (`closeConfirmMs`, `microsleepAlarmMs`). Ver §14 da auditoria: "frames
 * podem ser usados para proteção contra ruído e mínimo de amostras válidas".
 * 2 significa apenas "um quadro isolado nunca decide nada".
 */
const CONFIRM_MIN_FRAMES = 2;
/**
 * Janelas da tendência de EAR. Em MILISSEGUNDOS desde 2026-09-24: eram
 * contagens de amostra (20/10), que valiam ~2,5s a 8 FPS e passariam a valer
 * 0,67s ao subir o laço para 30 FPS — ver `temporal/earTrendTracker.ts`.
 * `EAR_TREND_MIN_SAMPLES` sobrevive apenas como piso de ruído.
 */
const EAR_TREND_MIN_OBSERVATION_MS = 2000;
const EAR_TREND_RECENT_WINDOW_MS = 1000;
const EAR_TREND_MIN_SAMPLES = 8;

function isEyeClosedish(state: EyeState): boolean {
    return state === 'CLOSED' || state === 'OPENING';
}

/**
 * `DetectionEngine` — ORQUESTRADOR (auditoria de arquitetura, 2026-09-23).
 *
 * Antes desta refatoração, esta classe fazia tudo inline: suavização de EAR,
 * histerese de fechamento, classificação de piscada/piscada-lenta, PERCLOS,
 * micro-sono, bocejo, queda de cabeça, tendência de EAR, decisão de
 * NORMAL/WARNING/ALARM, extração de features e despacho de efeitos
 * colaterais (WebSocket, estatísticas de sessão) — tudo em ~900 linhas.
 *
 * Agora ela só: (1) recebe um frame, (2) repassa a cada detector
 * especializado (todos testáveis isoladamente, ver `eye/`, `head/`,
 * `mouth/`, `temporal/`), (3) junta a evidência em `fuseSignals()`
 * (`fusion/signalFusion.ts`), (4) aplica a histerese de ENTRADA/SAÍDA de
 * estado (que depende do estado anterior — não é responsabilidade dos
 * detectores nem da fusão, que são sem-estado-de-transição por design),
 * (5) traduz a decisão em efeitos colaterais (eventos WebSocket,
 * estatísticas de sessão, publicação de métricas).
 *
 * O contrato público (processFrame/processNoFace/ackAlarm/reset/setPreset/
 * getState) e o formato de `DetectionMetrics` publicado NÃO mudaram — a
 * suíte de testes existente (227 testes antes desta refatoração) é a rede
 * de segurança que confirma isso. A ÚNICA mudança de comportamento
 * deliberada é o denominador do PERCLOS durante perda de rosto (ver
 * `eye/perclosTracker.ts` — aprovada explicitamente antes de implementar).
 */
export class DetectionEngine {
    private readonly clock: Clock;

    private state: DetectionState = 'NORMAL';
    private reason: AlarmReason | WarningReason | null = null;
    private config: DetectionConfig = { ...PRESETS.standard };
    private presetName: PresetName = 'standard';

    private eyeStateDetector: EyeStateDetector;
    private blinkDetector: BlinkDetector;
    private perclosTracker: PerclosTracker;
    private microsleepDetector: MicrosleepDetector;
    private headDropDetector: HeadDropDetector;
    private yawnDetector: YawnDetector;
    private earTrendTracker: EarTrendTracker;

    private facePresent = false;
    private faceLostSince: number | null = null;
    private faceLostReported = false;
    /** Estado do olho reportado no último frame — só para saber quando emitir EYES_CLOSED (transição). */
    private lastReportedClosed = false;

    private startedAt: number | null = null;
    private lastHeartbeatAt = 0;

    private lastFeatureVector: FeatureVector | null = null;
    private detectionMode: DetectionMode = 'hybrid';
    private lastMlScore: number | null = null;

    constructor(clock: Clock = systemClock) {
        this.clock = clock;
        this.eyeStateDetector = new EyeStateDetector(clock, this.eyeStateConfig());
        this.blinkDetector = new BlinkDetector(clock, this.blinkConfig());
        this.perclosTracker = new PerclosTracker(this.perclosConfig());
        this.microsleepDetector = new MicrosleepDetector(clock, this.microsleepConfig());
        this.headDropDetector = new HeadDropDetector(clock, this.headDropConfig());
        this.yawnDetector = new YawnDetector(clock, this.yawnConfig());
        this.earTrendTracker = new EarTrendTracker(clock, this.earTrendConfig());
    }

    // ── Tradução DetectionConfig (por preset) -> config de cada detector ──

    private eyeStateConfig() {
        return {
            closeConfirmMs: this.config.closeConfirmMs,
            closeConfirmMinFrames: CONFIRM_MIN_FRAMES,
            hysteresisFactor: this.config.hysteresisFactor,
            smoothingWindow: EAR_SMOOTHING_WINDOW,
        };
    }
    private blinkConfig() {
        return {
            minBlinkMs: this.config.minBlinkMs,
            maxBlinkMs: this.config.maxBlinkMs,
            slowBlinkMinMs: this.config.slowBlinkMinMs,
            slowBlinkMaxMs: this.config.microsleepAlarmMs,
            slowBlinkRateThreshold: this.config.slowBlinkRateThreshold,
            slowBlinkMinObservationMs: this.config.slowBlinkMinObservationMs,
        };
    }
    private perclosConfig() {
        return {
            windowMs: this.config.perclosWindowMs,
            ignoreMs: this.config.perclosIgnoreMs,
            minObservationMs: this.config.perclosMinObservationMs,
        };
    }
    private microsleepConfig() {
        return {
            thresholdFactor: this.config.microsleepThresholdFactor,
            alarmMs: this.config.microsleepAlarmMs,
            cooldownMs: this.config.microsleepCooldownMs,
            confirmFrames: CONFIRM_MIN_FRAMES,
        };
    }
    private headDropConfig() {
        return { margin: this.config.headDropMargin, minMs: this.config.headDropMinMs };
    }
    private yawnConfig() {
        return {
            mouthAspectThreshold: this.config.yawnMouthAspect,
            minMs: this.config.yawnMinMs,
            maxMs: this.config.yawnMaxMs,
            activeHoldMs: this.config.yawnActiveHoldMs,
            cooldownMs: this.config.yawnCooldownMs,
        };
    }
    private earTrendConfig() {
        return {
            windowMs: this.config.earTrendWindowMs,
            minObservationMs: EAR_TREND_MIN_OBSERVATION_MS,
            recentWindowMs: EAR_TREND_RECENT_WINDOW_MS,
            minSamples: EAR_TREND_MIN_SAMPLES,
        };
    }
    private fusionThresholds(): FusionThresholds {
        return {
            perclosWarn: this.config.perclosWarningLevel,
            perclosAlarm: this.config.perclosAlarmLevel,
            warnCloseMs: this.config.warnCloseMs,
            alarmCloseMs: this.config.drowsinessThresholdMs,
            microsleepAlarmMs: this.config.microsleepAlarmMs,
            earTrendWarn: this.config.earTrendWarnFraction,
            mlWarnThreshold: ML_WARNING_THRESHOLD,
            mlAlarmThreshold: ML_ALARM_THRESHOLD,
        };
    }

    private applyConfigToDetectors(): void {
        this.eyeStateDetector.updateConfig(this.eyeStateConfig());
        this.blinkDetector.updateConfig(this.blinkConfig());
        this.perclosTracker.updateConfig(this.perclosConfig());
        this.microsleepDetector.updateConfig(this.microsleepConfig());
        this.headDropDetector.updateConfig(this.headDropConfig());
        this.yawnDetector.updateConfig(this.yawnConfig());
        this.earTrendTracker.updateConfig(this.earTrendConfig());
    }

    private heartbeatIfAlarm(now: number): void {
        if (this.state === 'ALARM' && now - this.lastHeartbeatAt >= 3000) {
            this.lastHeartbeatAt = now;
            wsClient.sendEvent(EventType.HEARTBEAT, { state: this.state });
        }
    }

    public setPreset(name: PresetName): void {
        this.presetName = name;
        this.config = { ...PRESETS[name] };
        this.applyConfigToDetectors();
    }

    public getPreset(): PresetName {
        return this.presetName;
    }

    public getState(): DetectionState {
        return this.state;
    }

    public getLastBlinkAt(): number | null {
        return this.blinkDetector.getLastBlinkAt();
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
        this.eyeStateDetector.reset();
        this.blinkDetector.reset();
        this.perclosTracker.reset();
        this.microsleepDetector.reset();
        this.headDropDetector.reset();
        this.yawnDetector.reset();
        this.earTrendTracker.reset();
        this.facePresent = false;
        this.faceLostSince = null;
        this.faceLostReported = false;
        this.lastReportedClosed = false;
        this.startedAt = null;
        this.lastFeatureVector = null;
        this.lastMlScore = null;
        featureExtractor.reset();
        drowsinessModel.reset();
    }

    /**
     * Re-sincroniza o estado de alarme com o backend quando a conexão
     * WebSocket é restabelecida. É a única forma de re-armar o hardware
     * (buzzer/vibração) após uma queda de rede que disparou o watchdog.
     */
    public initReconnectSync(): void {
        wsClient.onReconnect(() => {
            if (this.state === 'ALARM') {
                const now = this.clock.now();
                this.lastHeartbeatAt = 0; // força próximo heartbeat imediato
                this.heartbeatIfAlarm(now);
                wsClient.sendEvent(EventType.DROWSINESS_STARTED, {
                    reason: this.reason,
                    perclos: this.currentPerclos(now, null).perclos,
                    closedForMs: 0,
                });
            }
        });
    }

    public ackAlarm(): void {
        // BUG histórico corrigido (ver .ai/memory.md, 2026-09-22): o reset
        // do estado do olho precisa limpar streak/candidato de fechamento —
        // sem isso o alarme podia voltar em <500ms, bem abaixo de qualquer
        // limiar real. EyeStateDetector.reset() cobre isso integralmente.
        this.eyeStateDetector.reset();
        this.blinkDetector.reset();
        this.perclosTracker.reset();
        this.microsleepDetector.markUnknown();
        this.earTrendTracker.reset();
        this.lastReportedClosed = false;
        this.state = 'NORMAL';
        this.reason = null;
        this.lastFeatureVector = null;
        this.lastMlScore = null;
        featureExtractor.reset();
        drowsinessModel.reset();
        wsClient.sendEvent(EventType.ALARM_ACKNOWLEDGED);
        metricsStore.publish({ ...DEFAULT_METRICS, threshold: calibrationManager.getThreshold() });
    }

    /**
     * Nenhum EAR confiável neste quadro. `quality` distingue "não vejo rosto"
     * (`LOST`) de "vejo rosto mas a geometria não serve" (`DEGRADED`) — ver
     * `vision/mediapipe.ts`. A DECISÃO é idêntica nos dois casos (sem EAR
     * confiável não se avalia sonolência); `quality` só muda o que a UI mostra.
     */
    public processNoFace(quality: Extract<VisionQuality, 'LOST' | 'DEGRADED'> = 'LOST'): void {
        const now = this.clock.now();
        this.sessionStart(now);
        sessionStats.markStarted(now);
        this.perclosTracker.markObservationStart(now);

        this.facePresent = false;
        if (this.faceLostSince === null) {
            this.faceLostSince = now;
        }
        const closedSegmentEnded = this.eyeStateDetector.markUnknown();
        if (closedSegmentEnded) {
            this.perclosTracker.recordClosedSegment(closedSegmentEnded);
            this.blinkDetector.onClosedSegment(closedSegmentEnded);
        }
        this.microsleepDetector.markUnknown();
        this.lastReportedClosed = false;
        // Sem isso, um "since" de antes da perda de rosto sobrevive ao gap:
        // o primeiro frame de EAR baixo após a reaquisição (ruído comum de
        // tracking) computaria a duração do micro-sono incluindo todo o
        // tempo em que o rosto esteve ausente, e um score de ML travado do
        // rosto anterior continuaria valendo para uma pessoa diferente.
        this.lastFeatureVector = null;
        featureExtractor.reset();
        drowsinessModel.reset();

        const lostFor = now - this.faceLostSince;
        if (!this.faceLostReported && lostFor >= this.config.faceLostWarnMs) {
            this.faceLostReported = true;
            wsClient.sendEvent(EventType.FACE_LOST, { lostForMs: lostFor });
        }

        if (this.state !== 'ALARM' && calibrationManager.canEvaluate()) {
            this.evaluate(now, 0, lostFor, null);
        }

        const perclosResult = this.currentPerclos(now, null);
        sessionStats.sample(now, 0, perclosResult.perclos, this.state);
        this.heartbeatIfAlarm(now);

        metricsStore.publish({
            ...DEFAULT_METRICS,
            state: this.state,
            reason: this.reason,
            facePresent: false,
            visionQuality: quality,
            faceLostForMs: lostFor,
            perclos: perclosResult.perclos,
            blinkRate: this.blinkDetector.getBlinkRate(now, perclosResult.validObservedMs),
            threshold: calibrationManager.getThreshold(),
            preset: this.presetName,
        });
    }

    public processFrame(frame: FrameAnalysis): void {
        const now = this.clock.now();
        this.sessionStart(now);
        sessionStats.markStarted(now);
        this.blinkDetector.markStarted();
        this.perclosTracker.markObservationStart(now);

        if (!this.facePresent) {
            this.facePresent = true;
            if (this.faceLostSince !== null) {
                this.perclosTracker.recordLostInterval({ start: this.faceLostSince, end: now });
            }
            this.faceLostSince = null;
            this.faceLostReported = false;
            wsClient.sendEvent(EventType.FACE_DETECTED);
        }

        const threshold = calibrationManager.getThreshold();
        const eyeUpdate = this.eyeStateDetector.update(frame.ear, threshold);
        const ear = eyeUpdate.ear;
        sessionStats.addEar(ear);

        if (eyeUpdate.closedSegmentEnded) {
            const seg = eyeUpdate.closedSegmentEnded;
            this.perclosTracker.recordClosedSegment(seg);
            const blinkEvent = this.blinkDetector.onClosedSegment(seg);
            if (blinkEvent.kind === 'normal') sessionStats.recordBlink(seg.end);
            if (seg.durationMs >= this.config.drowsinessThresholdMs) sessionStats.recordEpisode(seg.end);
            wsClient.sendEvent(EventType.EYES_OPEN, { ear });
        }

        const closedNow = isEyeClosedish(eyeUpdate.state);
        if (closedNow && !this.lastReportedClosed) {
            wsClient.sendEvent(EventType.EYES_CLOSED, { ear });
        }
        this.lastReportedClosed = closedNow;

        const yawnResult = this.yawnDetector.update(frame.mouthAspect);

        // Corrobora queda de cabeça com o estado do olho: alguém olhando pra
        // baixo alerta (painel, celular) mantém os olhos bem abertos, ao
        // passo que a queda de cabeça por sonolência real vem sempre com a
        // pálpebra caindo junto. Ver head/headDropDetector.ts.
        const eyesLookAlert = ear > threshold * this.config.hysteresisFactor;
        const headDropResult = this.headDropDetector.update(
            frame.noseDropRatio,
            calibrationManager.getBaselineNoseDrop(),
            eyesLookAlert,
        );

        const microsleepResult = this.microsleepDetector.update(ear, threshold);

        // Tendência de sonolência: coleta EAR apenas com olhos abertos.
        if (eyeUpdate.state === 'OPEN') {
            this.earTrendTracker.addOpenEyeSample(ear);
        }

        if (calibrationManager.canEvaluate()) {
            this.evaluate(now, eyeUpdate.closedForMs, 0, {
                eyeState: eyeUpdate.state,
                microsleepCandidateMs: microsleepResult.candidateMs,
                microsleepMeetsThreshold: microsleepResult.meetsThreshold,
                yawnActive: yawnResult.active,
                headDropped: headDropResult.dropped,
            });
        }

        const perclosResult = this.currentPerclos(now, closedNow ? eyeUpdate.closedForMs : null);
        const blinkRate = this.blinkDetector.getBlinkRate(now, perclosResult.validObservedMs);
        this.lastFeatureVector = featureExtractor.extract(frame, now, {
            perclos: perclosResult.perclos,
            blinkRate,
            lastBlinkAt: this.blinkDetector.getLastBlinkAt(),
        });
        if (this.lastFeatureVector) {
            mlDataCollector.collectFrame(this.lastFeatureVector);
            drowsinessModel.inferAsync(this.lastFeatureVector, now);
        }
        sessionStats.sample(now, ear, perclosResult.perclos, this.state);
        this.heartbeatIfAlarm(now);

        metricsStore.publish({
            state: this.state,
            reason: this.reason,
            facePresent: true,
            visionQuality: frame.quality,
            faceLostForMs: 0,
            eyesClosed: eyeUpdate.closed,
            closedForMs: eyeUpdate.closedForMs,
            ear,
            perclos: perclosResult.perclos,
            blinkRate,
            mouthAspect: frame.mouthAspect,
            yawnActive: yawnResult.active,
            noseDropRatio: frame.noseDropRatio,
            headDropped: headDropResult.dropped,
            threshold,
            preset: this.presetName,
            mlScore: this.lastMlScore,
        });
    }

    private sessionStart(now: number): void {
        if (this.startedAt === null) this.startedAt = now;
    }

    /**
     * PERCLOS no instante `now`. `liveClosedForMs` != null quando o olho
     * está fechado NESTE frame (alimenta a porção "ainda em andamento" via
     * `PerclosTracker.compute`); a perda de rosto "ao vivo" é sempre
     * derivada de `faceLostSince`.
     */
    private currentPerclos(now: number, liveClosedForMs: number | null) {
        const liveClosedSince = liveClosedForMs !== null ? now - liveClosedForMs : null;
        return this.perclosTracker.compute(now, liveClosedSince, this.faceLostSince);
    }

    private evaluate(
        now: number,
        closedForMs: number,
        faceLostForMs: number,
        live: {
            eyeState: EyeState;
            microsleepCandidateMs: number;
            microsleepMeetsThreshold: boolean;
            yawnActive: boolean;
            headDropped: boolean;
        } | null,
    ): void {
        const perclosResult = this.currentPerclos(
            now,
            live && isEyeClosedish(live.eyeState) ? closedForMs : null,
        );
        const perclos = perclosResult.perclos;
        const perclosValid = perclosResult.sufficient;

        // ML score: manter se fresco. Em ALARM, tolera um score mais velho
        // (até ML_STALE_DURING_ALARM_MS) para a histerese sobreviver a um
        // frame de inferência atrasado — mas nunca por tempo indefinido.
        const mlResult = drowsinessModel.getLastScore();
        const staleness = mlResult.at !== null ? now - mlResult.at : Infinity;
        const mlFresh = staleness <= ML_STALE_MS;
        const mlToleratedDuringAlarm = this.state === 'ALARM' && staleness <= ML_STALE_DURING_ALARM_MS;
        this.lastMlScore = (mlFresh || mlToleratedDuringAlarm) ? mlResult.score : null;

        const trendFraction = this.earTrendTracker.computeFraction(calibrationManager.getBaseline());
        const slowBlinksActive = this.blinkDetector.isSlowBlinksActive(now, perclosResult.validObservedMs);
        const faceLost = this.faceLostReported || faceLostForMs >= this.config.faceLostWarnMs;

        const fusion = fuseSignals(
            {
                perclos,
                perclosValid,
                yawnActive: live?.yawnActive ?? false,
                headDropped: live?.headDropped ?? false,
                faceLost,
                closedForMs,
                microsleepForMs: live?.microsleepCandidateMs ?? 0,
                microsleepMeetsThreshold: live?.microsleepMeetsThreshold ?? false,
                earTrendFraction: trendFraction,
                slowBlinksActive,
                mlScore: this.lastMlScore,
                mode: this.detectionMode,
            },
            this.fusionThresholds(),
        );

        if (this.state === 'ALARM') {
            // Histerese de release do ML: em modos que usam ML, só libera o
            // alarme quando o score ML cai claramente abaixo de ML_RELEASE_THRESHOLD.
            const mlRelease = this.detectionMode !== 'rules'
                ? (this.lastMlScore === null || this.lastMlScore < ML_RELEASE_THRESHOLD)
                : true;
            const eyesClosed = live !== null && isEyeClosedish(live.eyeState);

            // PERCLOS sem observação suficiente não pode BLOQUEAR a liberação
            // do alarme — do contrário uma razão calculada sobre poucos
            // segundos (logo após um ackAlarm, por exemplo) prenderia o
            // hardware ligado. Mesma regra de validade usada na fusão.
            const perclosForRelease = perclosValid ? perclos : 0;

            if (
                fusion.state !== 'ALARM' &&
                mlRelease &&
                !eyesClosed &&
                perclosForRelease < this.config.perclosReleaseLevel
            ) {
                this.state = fusion.state === 'WARNING' ? 'WARNING' : 'NORMAL';
                this.reason = fusion.state === 'WARNING' ? (fusion.primaryReason as WarningReason) : null;
                wsClient.sendEvent(EventType.DROWSINESS_ENDED, { perclos });
                if (this.state === 'WARNING') {
                    this.emitStateEntry(perclos, this.reason as WarningReason);
                }
            }
            return;
        }

        if (fusion.state === 'ALARM') {
            const finalAlarmReason = fusion.primaryReason as AlarmReason;
            if (finalAlarmReason === 'MICROSLEEP') this.microsleepDetector.markTriggered();
            this.state = 'ALARM';
            this.reason = finalAlarmReason;
            const microMs = live?.microsleepCandidateMs ?? 0;
            wsClient.sendEvent(EventType.DROWSINESS_STARTED, {
                reason: finalAlarmReason,
                perclos,
                closedForMs: microMs > 0 ? microMs : closedForMs,
            });
            return;
        }

        if (fusion.state === 'WARNING' && this.state === 'NORMAL') {
            this.state = 'WARNING';
            this.reason = fusion.primaryReason as WarningReason;
            sessionStats.recordWarning(now);
            this.emitStateEntry(perclos, this.reason);
            return;
        }

        if (fusion.state === 'WARNING' && this.state === 'WARNING' && fusion.primaryReason !== this.reason) {
            this.reason = fusion.primaryReason as WarningReason;
            wsClient.sendEvent(EventType.DROWSINESS_WARNING, { reason: this.reason, perclos });
            return;
        }

        // Release do WARNING com histerese: sinais que oscilam na borda do
        // limiar causavam flicker NORMAL↔WARNING a cada frame. Só sai do
        // WARNING quando a evidência cai para uma fração clara abaixo do
        // nível de entrada (default 80% do warn level).
        if (fusion.state !== 'WARNING' && this.state === 'WARNING') {
            const releaseFactor = this.config.warningReleaseFraction;
            const slowBlinkRate = this.blinkDetector.getSlowBlinkRate(now, perclosResult.validObservedMs);
            const stillWarn = (perclosValid && perclos >= this.config.perclosWarningLevel * releaseFactor) ||
                closedForMs >= this.config.warnCloseMs * releaseFactor ||
                (trendFraction !== null && trendFraction >= this.config.earTrendWarnFraction * releaseFactor) ||
                slowBlinkRate >= this.config.slowBlinkRateThreshold * releaseFactor;
            if (!stillWarn) {
                this.state = 'NORMAL';
                this.reason = null;
                wsClient.sendEvent(EventType.DROWSINESS_WARNING_ENDED, { perclos });
            }
        }
    }

    private emitStateEntry(perclos: number, reason: WarningReason): void {
        wsClient.sendEvent(EventType.DROWSINESS_WARNING, { reason, perclos });
    }
}

export const detectionEngine = new DetectionEngine();
