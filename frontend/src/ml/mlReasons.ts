import { ML_WARNING_THRESHOLD, ML_ALARM_THRESHOLD } from './thresholds';

export type DetectionMode = 'rules' | 'ml' | 'hybrid';
export type WarningReason = 'PERCLOS' | 'YAWN' | 'HEAD_DROP' | 'FACE_LOST' | 'PROLONGED_CLOSE' | 'ML_WARNING' | 'EAR_TREND' | 'SLOW_BLINKS';
export type AlarmReason = 'EYES_CLOSED_DURATION' | 'PERCLOS_CRITICAL' | 'ML_ALARM' | 'MICROSLEEP';

export function combineWarningReason(
    mode: DetectionMode,
    ruleWarn: WarningReason | null,
    mlScore: number | null,
): WarningReason | null {
    const mlWarn = mlScore !== null && mlScore >= ML_WARNING_THRESHOLD;

    switch (mode) {
        case 'rules':
            return ruleWarn;
        case 'ml':
            return mlWarn ? 'ML_WARNING' : ruleWarn;
        case 'hybrid':
            if (mlWarn) return 'ML_WARNING';
            return ruleWarn;
    }
}

/**
 * Uma regra de aviso conta como corroboração fisiológica para o ML escalar a
 * ALARM. FACE_LOST não conta: rosto ausente não é evidência de sonolência.
 */
export function isCorroboratingWarning(ruleWarn: WarningReason | null): boolean {
    return ruleWarn !== null && ruleWarn !== 'FACE_LOST';
}

/**
 * Política de alarme (decisão de 2026-09: o ONNX embarcado é EXPERIMENTAL e
 * foi treinado só com dados sintéticos — ver docs/ML_PIPELINE.md):
 *  - regra de alarme sempre dispara;
 *  - o ML NÃO origina ALARM sozinho: ML ≥ ML_ALARM_THRESHOLD só escala para
 *    ML_ALARM quando há uma regra de aviso fisiológica ativa (`ruleWarn`).
 *    Sem corroboração o ML limita-se a ML_WARNING (ver combineWarningReason).
 *
 * Nota: hoje os modos 'ml' e 'hybrid' são equivalentes (ambos usam regras +
 * ML); 'ml' não significa "somente ML".
 */
export function combineAlarmReason(
    mode: DetectionMode,
    ruleAlarm: AlarmReason | null,
    mlScore: number | null,
    ruleWarn: WarningReason | null,
): AlarmReason | null {
    if (ruleAlarm !== null) return ruleAlarm;
    if (mode === 'rules') return null;
    const mlAlarm = mlScore !== null && mlScore >= ML_ALARM_THRESHOLD;
    return mlAlarm && isCorroboratingWarning(ruleWarn) ? 'ML_ALARM' : null;
}
