/**
 * Fusão multi-sinal de sonolência com score de confiança (0-1).
 *
 * Substitui a lógica OR com short-circuit: em vez de "a primeira condição
 * que bater vence", cada sinal contribui com um score contínuo ponderado.
 * Sinais fracos múltiplos e simultâneos (ex: PERCLOS 26% + bocejo leve +
 * cabeça caindo) agora somam evidência em vez de competirem entre si.
 *
 * Funções puras (sem dependências) — testáveis isoladamente.
 */

export interface SignalInputs {
    /** PERCLOS normalizado 0-1 (janela 60s). */
    perclos: number;
    /** Bocejo ativo no momento. */
    yawnActive: boolean;
    /** Cabeça abaixada ativa no momento. */
    headDropped: boolean;
    /** Rosto ausente reportado. */
    faceLost: boolean;
    /** ms contínuos com olhos fechados. */
    closedForMs: number;
    /** ms contínuos "bem fechados" (candidato a micro-sono). */
    microsleepForMs: number;
    /** Fração de declínio do EAR vs baseline (null se sem calibração). */
    earTrendFraction: number | null;
    /** Score ML 0-1 (null se indisponível/velho). */
    mlScore: number | null;
}

export interface FusionThresholds {
    perclosWarn: number;
    perclosAlarm: number;
    warnCloseMs: number;
    alarmCloseMs: number;
    microsleepAlarmMs: number;
    earTrendWarn: number;
}

export interface FusionResult {
    /** Confiança agregada de AVISO (WARNING) 0-1. */
    warningScore: number;
    /** Confiança agregada de ALARME 0-1. */
    alarmScore: number;
    /** Razão do maior contribuidor individual (para o badge). */
    dominantReason: string | null;
}

/**
 * Interpola linearmente a confiança de um valor entre dois pontos de
 * referência. Retorna 0 abaixo de `low` e 1 acima de `high`.
 */
function ramp(value: number, low: number, high: number): number {
    if (high <= low) return value >= high ? 1 : 0;
    const t = (value - low) / (high - low);
    return Math.min(1, Math.max(0, t));
}

/** Peso de cada sinal na fusão. Soma não precisa ser 1: scores são limitados. */
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

/** Limiar agregado para considerar o estado atingido. */
const WARNING_ENTER = 0.55;
const ALARM_ENTER = 1.0;

/**
 * Combina todos os sinais em scores contínuos de warning/alarm.
 *
 * Cada sinal mapeia para uma confiança [0,1] (por intensidade/duração),
 * é multiplicado pelo seu peso e somado. ML entra como evidência extra
 * quando disponível. A razão dominante é a de maior contribuição
 * individual — o badge continua mostrando a causa mais provável.
 */
export function fuseSignals(
    inputs: SignalInputs,
    thresholds: FusionThresholds,
): FusionResult {
    const contributions: Array<{ reason: string; score: number }> = [];
    let warningSum = 0;
    let alarmSum = 0;

    // --- PERCLOS (crônico): escala contínua entre warn e alarm ---
    if (inputs.perclos >= thresholds.perclosWarn) {
        const intensity = ramp(inputs.perclos, thresholds.perclosWarn, thresholds.perclosAlarm);
        const s = intensity * WEIGHTS.perclos;
        warningSum += s;
        contributions.push({ reason: 'PERCLOS', score: s });
        // Acima do nível de alarme, o PERCLOS também alimenta o alarm score.
        if (inputs.perclos >= thresholds.perclosAlarm) {
            alarmSum += s;
        }
    }

    // --- Bocejo: binário, peso baixo (sinal auxiliar, não conclusivo) ---
    if (inputs.yawnActive) {
        warningSum += WEIGHTS.yawn;
        contributions.push({ reason: 'YAWN', score: WEIGHTS.yawn });
    }

    // --- Queda de cabeça: binário, peso baixo ---
    if (inputs.headDropped) {
        warningSum += WEIGHTS.headDrop;
        contributions.push({ reason: 'HEAD_DROP', score: WEIGHTS.headDrop });
    }

    // --- Rosto ausente: peso menor (não é sonolência em si) ---
    if (inputs.faceLost) {
        warningSum += WEIGHTS.faceLost;
        contributions.push({ reason: 'FACE_LOST', score: WEIGHTS.faceLost });
    }

    // --- Fechamento prolongado: escala com a duração ---
    if (inputs.closedForMs >= thresholds.warnCloseMs) {
        const intensity = ramp(inputs.closedForMs, thresholds.warnCloseMs, thresholds.alarmCloseMs);
        const s = intensity * WEIGHTS.prolongedClose;
        warningSum += s;
        contributions.push({ reason: 'PROLONGED_CLOSE', score: s });
    }

    // --- Micro-sono: o sinal mais crítico — peso alto no alarme ---
    if (inputs.microsleepForMs > 0) {
        const intensity = ramp(inputs.microsleepForMs, thresholds.microsleepAlarmMs * 0.5, thresholds.microsleepAlarmMs);
        if (intensity > 0) {
            const s = intensity * WEIGHTS.microsleep;
            warningSum += s * 0.6;
            alarmSum += s;
            contributions.push({ reason: 'MICROSLEEP', score: s });
        }
    }

    // --- Tendência de EAR: evidência prodrômica de baixo peso ---
    if (inputs.earTrendFraction !== null && inputs.earTrendFraction >= thresholds.earTrendWarn) {
        const intensity = ramp(inputs.earTrendFraction, thresholds.earTrendWarn, thresholds.earTrendWarn * 2);
        const s = intensity * WEIGHTS.earTrend;
        warningSum += s;
        contributions.push({ reason: 'EAR_TREND', score: s });
    }

    // --- ML: evidência contínua — score alto alimenta ambos os níveis ---
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

    // Razão dominante = maior contribuição individual.
    contributions.sort((a, b) => b.score - a.score);
    const dominantReason = contributions.length > 0 ? contributions[0].reason : null;

    return {
        warningScore: Math.min(1.5, warningSum),
        alarmScore: Math.min(1.5, alarmSum),
        dominantReason,
    };
}

/** Um score de warning atingiu o nível de entrada? */
export function isWarning(fusion: FusionResult): boolean {
    return fusion.warningScore >= WARNING_ENTER;
}

/** Um score de alarme atingiu o nível de entrada? */
export function isAlarm(fusion: FusionResult): boolean {
    return fusion.alarmScore >= ALARM_ENTER;
}
