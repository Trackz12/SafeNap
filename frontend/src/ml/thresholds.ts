export const ML_WARNING_THRESHOLD = 0.85;
export const ML_ALARM_THRESHOLD = 0.95;
export const ML_RELEASE_THRESHOLD = 0.70;
export const ML_STALE_MS = 1500;
// Teto de tolerância para o score ML durante um ALARM ativo: permite que a
// histerese sobreviva a um frame de inferência atrasado (o motivo original
// do bypass), mas nunca deixa um score travado (inferência que parou de
// rodar silenciosamente) bloquear a liberação do alarme para sempre.
export const ML_STALE_DURING_ALARM_MS = 8000;
export const INFERENCE_INTERVAL_MS = 200;
export const SMOOTHING_WINDOW = 3;
