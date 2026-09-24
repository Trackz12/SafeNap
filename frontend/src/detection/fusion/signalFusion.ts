/**
 * Fusão de sinais — fonte ÚNICA de decisão evidência→estado.
 *
 * ANTES (auditoria de arquitetura, 2026-09-23): existiam DOIS mecanismos de
 * fusão coexistindo. `DetectionEngine.evaluate()` decidia `ruleWarn`/
 * `ruleAlarm` por uma cadeia if/else de prioridade fixa, chamando
 * `combineWarningReason`/`combineAlarmReason` de `ml/mlReasons.ts` (regra
 * discreta + ML corroborativo). SÓ quando essa cadeia deixava `warnedReason`
 * ou `alarmReason` como `null` é que `signalFusion.ts` (scoring contínuo
 * ponderado) entrava como fallback. Duas filosofias de decisão diferentes
 * coexistindo, com precedência implícita — difícil de explicar/debugar/testar
 * como um todo.
 *
 * DEPOIS: um único módulo, com 3 camadas EXPLÍCITAS (não uma média ingênua):
 *
 *   1. Indicadores FORTES (strong): gatilhos determinísticos que, sozinhos,
 *      já definem o estado — MICROSLEEP, EYES_CLOSED_DURATION,
 *      PERCLOS_CRITICAL (alarme); PERCLOS/YAWN/HEAD_DROP/FACE_LOST/
 *      PROLONGED_CLOSE/EAR_TREND/SLOW_BLINKS (aviso). Mesma ordem de
 *      prioridade que a cadeia if/else original — PRESERVADA, não
 *      redecidida, porque não há dado novo que justifique reordenar.
 *   2. Indicadores experimentais (ML): corroborativo, nunca origina ALARM
 *      sozinho — mesma política de `mlReasons.ts`, agora dentro deste
 *      módulo em vez de um arquivo à parte chamado de dois lugares.
 *   3. Indicadores de suporte (fallback contínuo): quando NENHUM indicador
 *      forte disparou sozinho, os sinais fracos (bocejo leve, cabeça
 *      caindo, tendência de EAR, PERCLOS moderado, ML) somam evidência em
 *      vez de competir — mesma matemática de `ramp`/`WEIGHTS` que já existia
 *      no `signalFusion.ts` original, preservada byte a byte.
 *
 * Esta consolidação NÃO muda nenhum limiar nem prioridade — é uma
 * reorganização de onde o código mora, não uma redecisão de quando avisar/
 * alarmar. Comportamento verificado idêntico via os mesmos casos de teste
 * que existiam em `signalFusion.test.ts` + `ml/mlReasons.test.ts` antes da
 * unificação (ver `signalFusion.test.ts` atual).
 */

export type DetectionState = 'NORMAL' | 'WARNING' | 'ALARM';
export type DetectionMode = 'rules' | 'ml' | 'hybrid';

export type WarningReason =
    | 'PERCLOS' | 'YAWN' | 'HEAD_DROP' | 'FACE_LOST' | 'PROLONGED_CLOSE'
    | 'ML_WARNING' | 'EAR_TREND' | 'SLOW_BLINKS';
export type AlarmReason = 'EYES_CLOSED_DURATION' | 'PERCLOS_CRITICAL' | 'ML_ALARM' | 'MICROSLEEP';
export type DetectionReason = WarningReason | AlarmReason;

/** Camada de evidência de cada tipo de sinal — ver docstring do módulo. */
export type EvidenceTier = 'strong' | 'supporting' | 'experimental';

export const REASON_TIER: Record<DetectionReason, EvidenceTier> = {
    MICROSLEEP: 'strong',
    EYES_CLOSED_DURATION: 'strong',
    PERCLOS_CRITICAL: 'strong',
    PERCLOS: 'supporting',
    YAWN: 'supporting',
    HEAD_DROP: 'supporting',
    FACE_LOST: 'supporting',
    PROLONGED_CLOSE: 'supporting',
    EAR_TREND: 'supporting',
    SLOW_BLINKS: 'supporting',
    ML_WARNING: 'experimental',
    ML_ALARM: 'experimental',
};

export interface FusionInputs {
    perclos: number;
    /**
     * `PerclosResult.sufficient` — houve observação válida suficiente pra a
     * razão significar algo (auditoria de qualidade, 2026-09-23, achado nº 3).
     * Quando `false`, o PERCLOS é IGNORADO por completo nas três camadas:
     * não vira regra forte, não soma no score contínuo e não aparece em
     * `contributingSignals`. Antes, um PERCLOS calculado sobre poucos segundos
     * de observação tinha exatamente o mesmo peso de um calculado sobre a
     * janela cheia de 60 s.
     */
    perclosValid: boolean;
    yawnActive: boolean;
    headDropped: boolean;
    faceLost: boolean;
    closedForMs: number;
    /** ms contínuos do candidato a micro-sono (alimenta o score de suporte). */
    microsleepForMs: number;
    /** Gatilho determinístico já resolvido (streak + cooldown) pelo MicrosleepDetector. */
    microsleepMeetsThreshold: boolean;
    earTrendFraction: number | null;
    slowBlinksActive: boolean;
    mlScore: number | null;
    mode: DetectionMode;
}

export interface FusionThresholds {
    perclosWarn: number;
    perclosAlarm: number;
    warnCloseMs: number;
    alarmCloseMs: number;
    microsleepAlarmMs: number;
    earTrendWarn: number;
    mlWarnThreshold: number;
    mlAlarmThreshold: number;
}

export interface FusionResult {
    /** Estado sugerido pela evidência deste frame (sem histerese de saída — isso é do DecisionEngine). */
    state: DetectionState;
    warningScore: number;
    alarmScore: number;
    /** Razão explicativa principal — o que o badge/log/UI deve mostrar. */
    primaryReason: DetectionReason | null;
    /** Todos os sinais ativos neste frame, não só o vencedor — para debug/logs/TCC. */
    contributingSignals: DetectionReason[];
}

// ─── Camada 3: scoring contínuo de suporte (preservado de signalFusion.ts original) ───

function ramp(value: number, low: number, high: number): number {
    if (high <= low) return value >= high ? 1 : 0;
    const t = (value - low) / (high - low);
    return Math.min(1, Math.max(0, t));
}

const WEIGHTS = {
    perclos: 1.0,
    yawn: 0.35,
    headDrop: 0.35,
    faceLost: 0.2,
    prolongedClose: 0.4,
    microsleep: 1.2,
    earTrend: 0.3,
    ml: 0.9,
} as const;

const WARNING_ENTER = 0.55;
const ALARM_ENTER = 1.0;

function supportingScore(
    inputs: FusionInputs,
    thresholds: FusionThresholds,
): { warningScore: number; alarmScore: number; dominant: DetectionReason | null } {
    const contributions: Array<{ reason: DetectionReason; score: number }> = [];
    let warningSum = 0;
    let alarmSum = 0;

    if (inputs.perclosValid && inputs.perclos >= thresholds.perclosWarn) {
        const intensity = ramp(inputs.perclos, thresholds.perclosWarn, thresholds.perclosAlarm);
        const s = intensity * WEIGHTS.perclos;
        warningSum += s;
        contributions.push({ reason: 'PERCLOS', score: s });
        if (inputs.perclos >= thresholds.perclosAlarm) alarmSum += s;
    }
    if (inputs.yawnActive) {
        warningSum += WEIGHTS.yawn;
        contributions.push({ reason: 'YAWN', score: WEIGHTS.yawn });
    }
    if (inputs.headDropped) {
        warningSum += WEIGHTS.headDrop;
        contributions.push({ reason: 'HEAD_DROP', score: WEIGHTS.headDrop });
    }
    if (inputs.faceLost) {
        warningSum += WEIGHTS.faceLost;
        contributions.push({ reason: 'FACE_LOST', score: WEIGHTS.faceLost });
    }
    if (inputs.closedForMs >= thresholds.warnCloseMs) {
        const intensity = ramp(inputs.closedForMs, thresholds.warnCloseMs, thresholds.alarmCloseMs);
        const s = intensity * WEIGHTS.prolongedClose;
        warningSum += s;
        contributions.push({ reason: 'PROLONGED_CLOSE', score: s });
    }
    if (inputs.microsleepForMs > 0) {
        const intensity = ramp(inputs.microsleepForMs, thresholds.microsleepAlarmMs * 0.5, thresholds.microsleepAlarmMs);
        if (intensity > 0) {
            const s = intensity * WEIGHTS.microsleep;
            warningSum += s * 0.6;
            alarmSum += s;
            contributions.push({ reason: 'MICROSLEEP', score: s });
        }
    }
    if (inputs.earTrendFraction !== null && inputs.earTrendFraction >= thresholds.earTrendWarn) {
        const intensity = ramp(inputs.earTrendFraction, thresholds.earTrendWarn, thresholds.earTrendWarn * 2);
        const s = intensity * WEIGHTS.earTrend;
        warningSum += s;
        contributions.push({ reason: 'EAR_TREND', score: s });
    }
    if (inputs.mlScore !== null) {
        const warnEvidence = ramp(inputs.mlScore, 0.7, 0.85) * WEIGHTS.ml;
        const alarmEvidence = ramp(inputs.mlScore, 0.85, 0.95) * WEIGHTS.ml;
        warningSum += warnEvidence;
        alarmSum += alarmEvidence;
        if (inputs.mlScore >= 0.85) {
            contributions.push({
                reason: inputs.mlScore >= 0.95 ? 'ML_ALARM' : 'ML_WARNING',
                score: Math.max(warnEvidence, alarmEvidence),
            });
        }
    }

    contributions.sort((a, b) => b.score - a.score);
    return {
        warningScore: Math.min(1.5, warningSum),
        alarmScore: Math.min(1.5, alarmSum),
        dominant: contributions.length > 0 ? contributions[0].reason : null,
    };
}

function isCorroboratingWarning(reason: WarningReason | null): boolean {
    return reason !== null && reason !== 'FACE_LOST';
}

/**
 * Camada 1: indicadores fortes, prioridade fixa (idêntica à cadeia if/else
 * original de `DetectionEngine.evaluate()`).
 */
function strongRuleReasons(
    inputs: FusionInputs,
    thresholds: FusionThresholds,
): { ruleWarn: WarningReason | null; ruleAlarm: AlarmReason | null } {
    let ruleWarn: WarningReason | null = null;
    if (inputs.perclosValid && inputs.perclos >= thresholds.perclosWarn) ruleWarn = 'PERCLOS';
    else if (inputs.yawnActive) ruleWarn = 'YAWN';
    else if (inputs.headDropped) ruleWarn = 'HEAD_DROP';
    else if (inputs.faceLost) ruleWarn = 'FACE_LOST';
    else if (inputs.closedForMs >= thresholds.warnCloseMs) ruleWarn = 'PROLONGED_CLOSE';
    else if (inputs.earTrendFraction !== null && inputs.earTrendFraction >= thresholds.earTrendWarn) ruleWarn = 'EAR_TREND';
    else if (inputs.slowBlinksActive) ruleWarn = 'SLOW_BLINKS';

    let ruleAlarm: AlarmReason | null = null;
    if (inputs.microsleepMeetsThreshold) ruleAlarm = 'MICROSLEEP';
    else if (inputs.closedForMs >= thresholds.alarmCloseMs) ruleAlarm = 'EYES_CLOSED_DURATION';
    else if (inputs.perclosValid && inputs.perclos >= thresholds.perclosAlarm) ruleAlarm = 'PERCLOS_CRITICAL';

    return { ruleWarn, ruleAlarm };
}

/** Todos os sinais fisicamente ativos neste frame — para `contributingSignals` (explicabilidade). */
function activeSignals(inputs: FusionInputs, thresholds: FusionThresholds): DetectionReason[] {
    const active: DetectionReason[] = [];
    if (inputs.perclosValid && inputs.perclos >= thresholds.perclosAlarm) active.push('PERCLOS_CRITICAL');
    else if (inputs.perclosValid && inputs.perclos >= thresholds.perclosWarn) active.push('PERCLOS');
    if (inputs.yawnActive) active.push('YAWN');
    if (inputs.headDropped) active.push('HEAD_DROP');
    if (inputs.faceLost) active.push('FACE_LOST');
    if (inputs.closedForMs >= thresholds.alarmCloseMs) active.push('EYES_CLOSED_DURATION');
    else if (inputs.closedForMs >= thresholds.warnCloseMs) active.push('PROLONGED_CLOSE');
    if (inputs.microsleepMeetsThreshold) active.push('MICROSLEEP');
    if (inputs.earTrendFraction !== null && inputs.earTrendFraction >= thresholds.earTrendWarn) active.push('EAR_TREND');
    if (inputs.slowBlinksActive) active.push('SLOW_BLINKS');
    if (inputs.mlScore !== null && inputs.mlScore >= thresholds.mlAlarmThreshold) active.push('ML_ALARM');
    else if (inputs.mlScore !== null && inputs.mlScore >= thresholds.mlWarnThreshold) active.push('ML_WARNING');
    return active;
}

export function fuseSignals(inputs: FusionInputs, thresholds: FusionThresholds): FusionResult {
    const { ruleWarn, ruleAlarm } = strongRuleReasons(inputs, thresholds);

    // Camada 2: ML corroborativo (idêntico a mlReasons.ts::combineWarningReason/combineAlarmReason).
    const mlWarn = inputs.mlScore !== null && inputs.mlScore >= thresholds.mlWarnThreshold;
    const mlAlarmCandidate = inputs.mlScore !== null && inputs.mlScore >= thresholds.mlAlarmThreshold;

    let warnedReason: DetectionReason | null = ruleWarn;
    if (inputs.mode !== 'rules' && mlWarn) warnedReason = 'ML_WARNING';

    let alarmReason: DetectionReason | null = ruleAlarm;
    if (alarmReason === null && inputs.mode !== 'rules') {
        alarmReason = mlAlarmCandidate && isCorroboratingWarning(ruleWarn) ? 'ML_ALARM' : null;
    }

    // Camada 3: fallback contínuo — só quando a camada 1+2 não decidiu algo sozinha.
    if ((warnedReason === null || alarmReason === null) && inputs.mode !== 'rules') {
        const fusion = supportingScore(inputs, thresholds);

        if (alarmReason === null && fusion.alarmScore >= ALARM_ENTER) {
            const dom = fusion.dominant;
            if (dom === 'ML_ALARM' || dom === 'MICROSLEEP') alarmReason = dom;
            else if (dom !== null && inputs.mlScore !== null && inputs.mlScore >= 0.95) alarmReason = 'ML_ALARM';
            else if (dom === 'PERCLOS') alarmReason = 'PERCLOS_CRITICAL';
            else alarmReason = 'ML_ALARM';
        }
        if (alarmReason === 'ML_ALARM' && !isCorroboratingWarning(ruleWarn)) alarmReason = null;

        if (warnedReason === null && fusion.warningScore >= WARNING_ENTER) {
            const dom = fusion.dominant;
            warnedReason = (dom === 'PERCLOS' || dom === 'YAWN' || dom === 'HEAD_DROP' ||
                dom === 'FACE_LOST' || dom === 'PROLONGED_CLOSE' || dom === 'EAR_TREND')
                ? dom
                : 'ML_WARNING';
        }
    }

    const state: DetectionState = alarmReason !== null ? 'ALARM' : warnedReason !== null ? 'WARNING' : 'NORMAL';
    const primaryReason = alarmReason ?? warnedReason;
    const contributingSignals = activeSignals(inputs, thresholds);

    // Score numérico para debug/UI: reaproveita o cálculo contínuo mesmo
    // quando a decisão veio da camada 1 (regra forte) — útil pra saber "o
    // quão perto" outros sinais estavam contribuindo, não só o vencedor.
    const { warningScore, alarmScore } = supportingScore(inputs, thresholds);

    return { state, warningScore, alarmScore, primaryReason, contributingSignals };
}
