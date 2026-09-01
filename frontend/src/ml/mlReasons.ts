import { ML_WARNING_THRESHOLD, ML_ALARM_THRESHOLD } from './thresholds';

export type DetectionMode = 'rules' | 'ml' | 'hybrid';
export type WarningReason = 'PERCLOS' | 'YAWN' | 'HEAD_DROP' | 'FACE_LOST' | 'PROLONGED_CLOSE' | 'ML_WARNING' | 'EAR_TREND';
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

export function combineAlarmReason(
    mode: DetectionMode,
    ruleAlarm: AlarmReason | null,
    mlScore: number | null,
): AlarmReason | null {
    const mlAlarm = mlScore !== null && mlScore >= ML_ALARM_THRESHOLD;

    switch (mode) {
        case 'rules':
            return ruleAlarm;
        case 'ml':
            return mlAlarm ? 'ML_ALARM' : ruleAlarm;
        case 'hybrid':
            if (mlAlarm) return 'ML_ALARM';
            return ruleAlarm;
    }
}
