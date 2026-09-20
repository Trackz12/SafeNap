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
// Inferência que não volta neste prazo é tratada como falha e seu resultado
// descartado. Maior que ML_STALE_MS: enquanto trava, o score envelhece e as
// regras assumem sozinhas.
export const INFERENCE_TIMEOUT_MS = 2000;
// Falhas consecutivas antes de o status do modelo virar 'error' na UI.
export const MAX_CONSECUTIVE_FAILURES = 3;
export const SMOOTHING_WINDOW = 3;

/**
 * Modelo do usuário (RF treinado em runtime com pseudo-rótulos do ONNX) é
 * EXPERIMENTAL: sem holdout, sem métrica, treinado durante a sessão. Por padrão
 * fica FORA do caminho de segurança — não pontua, não treina sozinho. Só liga
 * com VITE_ENABLE_USER_MODEL=true (experimentação). Lido a cada chamada.
 */
export function isUserModelEnabled(): boolean {
    return import.meta.env?.VITE_ENABLE_USER_MODEL === 'true';
}
