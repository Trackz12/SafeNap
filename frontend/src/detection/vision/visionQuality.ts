/**
 * Qualidade do sinal de visão no frame atual.
 *
 * Motivo (auditoria de arquitetura, 2026-09-23): antes disso só existia
 * `facePresent: boolean`. Isso conflava dois casos bem diferentes:
 *   - `frameAnalyzer.analyzeFrame()` retorna `null` quando o MediaPipe não
 *     encontrou rosto algum (rosto genuinamente ausente);
 *   - `analyzeFrame()` TAMBÉM retorna `null` quando encontrou um rosto mas a
 *     geometria não é confiável (landmark perto da borda do frame, face
 *     largura abaixo de `MIN_FACE_WIDTH`, valores não-finitos) — ver
 *     `frameAnalyzer.ts` `nearEdge()`/`MIN_FACE_WIDTH`.
 * Os dois casos viram exatamente o mesmo caminho (`processNoFace()`) hoje.
 * Não é um bug de comportamento (ambos corretamente não avaliam sonolência
 * sem um EAR confiável), mas é uma perda de informação: "rosto ausente" e
 * "rosto presente mas em pose ruim" pedem mensagens de UI diferentes, e a
 * distinção é exatamente o dado que o PERCLOS precisa para não diluir sua
 * métrica durante trechos de baixa confiança (ver `perclosTracker.ts`).
 *
 * GOOD: rosto detectado, geometria confiável — features (EAR/mouth/nose) são
 *       significativas.
 * DEGRADED: reservado para uma futura gradação de confiança (ex.: yaw
 *       extremo, iluminação baixa reportada pelo MediaPipe) — hoje
 *       `frameAnalyzer` não distingue "degradado" de "perdido" internamente
 *       (tudo que falha os checks de geometria vira `null`), então este
 *       enum existe para o TIPO já estar certo quando essa distinção for
 *       implementada, sem precisar mudar a assinatura de novo. NEEDS
 *       VALIDATION: quais critérios do frameAnalyzer deveriam rebaixar para
 *       DEGRADED em vez de LOST é uma decisão que precisa de dados reais de
 *       uso, não um valor "razoável" inventado agora.
 * LOST: nenhum rosto confiável neste frame — nem `analyzeFrame` retornou um
 *       resultado usável.
 */
export type VisionQuality = 'GOOD' | 'DEGRADED' | 'LOST';

/**
 * Sinal com validade e confiança explícitas, em vez de usar `0`/`null` como
 * sentinela ambíguo de "sem dado" (ver `DEFAULT_METRICS.ear = 0` publicado
 * durante `processNoFace()` no código pré-refatoração — um consumidor que
 * lesse `metrics.ear` sem checar `facePresent` primeiro interpretaria "sem
 * rosto" como "olhos no máximo fechados").
 *
 * Só usado onde a ambiguidade do sentinela é um risco real (ver cada uso);
 * não introduzido em todo campo numérico do sistema — isso violaria a
 * própria auditoria (Seção 18: não complicar arquitetura sem necessidade).
 */
export interface Signal<T> {
    value: T;
    valid: boolean;
    confidence: number;
}

export function validSignal<T>(value: T, confidence = 1): Signal<T> {
    return { value, valid: true, confidence };
}

export function invalidSignal<T>(fallback: T): Signal<T> {
    return { value: fallback, valid: false, confidence: 0 };
}
