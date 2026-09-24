import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { analyzeFrame } from "./frameAnalyzer";
import { detectionEngine } from "../detection/detectionEngine";
import { calibrationManager } from "../safety/calibrationManager";
import { EventType, wsClient } from "../websocket/socketClient";

const LOCAL_WASM_PATH = "/mediapipe/wasm";
const LOCAL_MODEL_PATH = "/mediapipe/models/face_landmarker.task";
const CDN_WASM_PATH = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const CDN_MODEL_PATH = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/**
 * Cadência do laço de detecção.
 *
 * MUDANÇA DE COMPORTAMENTO (2026-09-24, próximo passo da auditoria de qualidade):
 *
 *   ANTES: `setTimeout(..., 100)` FIXO encadeado com `requestAnimationFrame`,
 *          somado ao tempo da própria detecção. Consequências medidas:
 *          (a) a cadência real MEDIDA era de 8 FPS (100 ms de espera + até
 *              ~17 ms de espera pelo rAF + o custo da detecção), não os 30 FPS
 *              da câmera. Como TODO fenômeno ocular é medido em tempo (ver
 *              `detection/eye/eyeStateDetector.ts`), um período de ~125 ms impõe
 *              um teto de resolução temporal a piscada, micro-sono e PERCLOS;
 *          (b) a espera era fixa, então o custo da detecção SOMAVA em vez de
 *              ser absorvido: numa máquina lenta (detecção de 40 ms) o período
 *              ia para ~157 ms (~6 FPS) — degradação composta;
 *          (c) o `requestAnimationFrame` no caminho de agendamento fazia a
 *              detecção PARAR por completo quando a aba não estava pintando.
 *              Para um monitor de segurança isso é pior que rodar devagar.
 *
 *   DEPOIS: orçamento de quadro com espera adaptativa. A espera é o que RESTA
 *           do orçamento depois da detecção, com dois pisos:
 *             - `MIN_LOOP_DELAY_MS`: a main thread sempre respira;
 *             - teto de ciclo de trabalho (`MAX_DUTY_CYCLE`): a espera nunca é
 *               menor que o tempo gasto detectando, então o laço não passa de
 *               ~50% de um núcleo. Numa máquina lenta a taxa cai sozinha em vez
 *               de travar a interface.
 *           O `requestAnimationFrame` saiu do caminho de agendamento.
 *
 *   MEDIDO (navegador real, `tests/e2e/detection-rate.spec.ts`): 8 FPS antes,
 *           30 FPS depois — 3,75x mais resolução temporal. Os dois números são
 *           medição, não estimativa: o valor "antes" foi obtido revertendo este
 *           trecho e rodando o mesmo teste.
 *
 *   RISCO: mais quadros por segundo = mais CPU. Mitigado pelo teto de ciclo de
 *          trabalho e pelo canvas de 320 px que já era usado. A taxa alcançada
 *          é instrumentada (`getDetectionFps()`) e mostrada na interface, então
 *          uma regressão de desempenho fica visível em vez de silenciosa.
 *
 * ENGINEERING PARAMETER / NEEDS VALIDATION: `TARGET_FRAME_MS` (33 ms) casa com
 * os 30 FPS típicos de webcam — acima disso o guarda de `lastVideoTime`
 * descartaria quadros repetidos de qualquer forma. `MAX_DUTY_CYCLE` (0,5) é uma
 * escolha de engenharia para não monopolizar a main thread, não um número
 * medido. Validação: medir a taxa alcançada e o custo por quadro nas máquinas
 * reais da demonstração.
 */
const TARGET_FRAME_MS = 33;
const MIN_LOOP_DELAY_MS = 8;
const MAX_DUTY_CYCLE = 0.5;
/** Constante de suavização da média exponencial da taxa observada. */
const FPS_EMA_ALPHA = 0.2;

async function fetchExists(url: string): Promise<boolean> {
    try {
        const res = await fetch(url, { method: "HEAD" });
        return res.ok;
    } catch {
        return false;
    }
}

export class MediaPipeManager {
    private faceLandmarker: FaceLandmarker | null = null;
    private initializing: Promise<void> | null = null;
    private runningMode: "VIDEO" | "IMAGE" = "VIDEO";
    private isDetecting: boolean = false;
    private lastVideoTime: number = -1;

    private offscreenCanvas: HTMLCanvasElement | null = null;
    private offscreenCtx: CanvasRenderingContext2D | null = null;

    /** Handle do setTimeout do loop de detecção — permite cancelamento limpo. */
    private loopTimer: ReturnType<typeof setTimeout> | null = null;

    /** Média exponencial da cadência REAL de detecção (quadros/s), 0 se parado. */
    private detectionFps = 0;
    /** Duração do último passo de detecção (ms) — custo, não cadência. */
    private lastDetectMs = 0;
    /** Instante do início do passo anterior, para derivar o período real. */
    private lastLoopStartedAt: number | null = null;

    constructor() {
        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCanvas.width = 320;
        this.offscreenCanvas.height = 240;
        this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });
        if (this.offscreenCtx) {
            // Filtro removido — imagens naturais do vídeo são melhores
            // para o modelo MediaPipe do que ajustes artificiais de brilho/contraste.
        }
    }

    private ensureCanvasForVideo(videoElement: HTMLVideoElement): void {
        if (!this.offscreenCanvas || !this.offscreenCtx) return;
        const vw = videoElement.videoWidth;
        const vh = videoElement.videoHeight;
        if (!vw || !vh) return;
        const targetWidth = 320;
        const targetHeight = Math.max(1, Math.round((targetWidth * vh) / vw));
        if (
            this.offscreenCanvas.width !== targetWidth ||
            this.offscreenCanvas.height !== targetHeight
        ) {
            this.offscreenCanvas.width = targetWidth;
            this.offscreenCanvas.height = targetHeight;
        }
    }

    private async resolveAssets(): Promise<{ wasmPath: string; modelPath: string }> {
        if (await fetchExists(`${LOCAL_WASM_PATH}/vision_wasm_internal.js`)) {
            return { wasmPath: LOCAL_WASM_PATH, modelPath: LOCAL_MODEL_PATH };
        }
        console.warn("Assets locais do MediaPipe indisponíveis; usando CDN como fallback.");
        return { wasmPath: CDN_WASM_PATH, modelPath: CDN_MODEL_PATH };
    }

    public async initialize(): Promise<void> {
        if (this.faceLandmarker) return;
        if (this.initializing) return this.initializing;

        this.initializing = (async () => {
            console.log("Inicializando MediaPipe...");
            const { wasmPath, modelPath } = await this.resolveAssets();
            const vision = await FilesetResolver.forVisionTasks(wasmPath);

            this.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: modelPath,
                    delegate: "CPU"
                },
                outputFaceBlendshapes: false,
                runningMode: this.runningMode,
                numFaces: 1,
                // Limiares reduzidos para aceitar faces parciais/perfil.
                // Default (0.5) descarta faces que o modelo não enxerga 100% frontais.
                minFaceDetectionConfidence: 0.3,
                minFacePresenceConfidence: 0.3,
                minTrackingConfidence: 0.5,
            });
            console.log("MediaPipe Inicializado!");
        })().catch((err) => {
            this.initializing = null;
            throw err;
        });

        return this.initializing;
    }

    /** Cancela o loop de detecção de forma limpa, liberando handles. */
    private cancelLoop(): void {
        if (this.loopTimer !== null) {
            clearTimeout(this.loopTimer);
            this.loopTimer = null;
        }
    }

    /**
     * Reagenda o laço esperando o que RESTA do orçamento de quadro, respeitando
     * o piso mínimo e o teto de ciclo de trabalho. Ver docstring de
     * TARGET_FRAME_MS para o racional.
     */
    private scheduleNextFrame(videoElement: HTMLVideoElement, workMs: number): void {
        if (!this.isDetecting) return;
        const budgetRemaining = TARGET_FRAME_MS - workMs;
        // Nunca esperar menos que o tempo gasto trabalhando (duty cycle <= 50%).
        const dutyFloor = workMs * (1 / MAX_DUTY_CYCLE - 1);
        const delay = Math.max(MIN_LOOP_DELAY_MS, budgetRemaining, dutyFloor);
        this.loopTimer = setTimeout(() => this.runDetectionLoop(videoElement), delay);
    }

    private runDetectionLoop(videoElement: HTMLVideoElement): void {
        if (!this.faceLandmarker || !this.isDetecting) return;

        const loopStart = performance.now();
        if (!videoElement || videoElement.readyState < 3 || videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
            // Vídeo ainda não pronto: nada a medir, espera curta e barata.
            this.scheduleNextFrame(videoElement, 0);
            return;
        }

        const startTimeMs = loopStart;
        if (this.lastVideoTime !== videoElement.currentTime) {
            this.lastVideoTime = videoElement.currentTime;

            try {
                if (this.offscreenCanvas && this.offscreenCtx && this.faceLandmarker) {
                    this.ensureCanvasForVideo(videoElement);
                    this.offscreenCtx.drawImage(videoElement, 0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
                    const results = this.faceLandmarker.detectForVideo(this.offscreenCanvas, startTimeMs);

                    if (results.faceLandmarks && results.faceLandmarks.length > 0) {
                        const analysis = analyzeFrame(results.faceLandmarks[0]);
                        if (analysis) {
                            calibrationManager.addSample(analysis.ear, analysis.noseDropRatio);
                            detectionEngine.processFrame(analysis);
                        } else {
                            // BUG CORRIGIDO (auditoria de qualidade, 2026-09-23,
                            // achado nº 1): antes daqui NÃO SAÍA CHAMADA NENHUMA
                            // quando o MediaPipe achava um rosto mas a geometria
                            // era inutilizável (face pequena, landmark na borda,
                            // valor não-finito). O quadro era silenciosamente
                            // descartado, com duas consequências reais:
                            //   1. `faceLostSince` nunca era setado, então o
                            //      PerclosTracker não marcava o intervalo como
                            //      perdido — o tempo entrava no denominador como
                            //      observação válida sem contribuição de
                            //      fechamento, diluindo o PERCLOS (falso negativo);
                            //   2. `markUnknown()` nunca era chamado, então
                            //      `closedSince` e o candidato a micro-sono
                            //      SOBREVIVIAM ao intervalo. Olhos fechados +
                            //      cabeça virando = ao voltar um quadro válido,
                            //      `closedForMs` incluía todo o buraco → ALARME
                            //      FALSO.
                            // Rotear para o mesmo caminho de "sem EAR confiável"
                            // é o correto: geometria ruim e rosto ausente são
                            // indistinguíveis para fins de decisão ocular. A
                            // diferença que importa para a UI é preservada via
                            // VisionQuality: DEGRADED = "estou vendo você, mas
                            // não confio no sinal dos olhos" (peça pra ajustar a
                            // posição), LOST = "não vejo rosto nenhum".
                            detectionEngine.processNoFace('DEGRADED');
                        }
                    } else {
                        detectionEngine.processNoFace('LOST');
                    }
                }
            } catch (e) {
                console.error("Erro na detecção do MediaPipe:", e);
            }

            // Instrumentação: custo do passo e cadencia REAL alcançada.
            // Antes disso, o único "FPS" exibido na interface era um contador de
            // requestAnimationFrame, isto é, a taxa de RENDER do navegador
            // (~60), e não a taxa de detecção (~10) — um número verdadeiro
            // sobre a coisa errada. Agora a taxa publicada é a da detecção.
            this.lastDetectMs = performance.now() - loopStart;
            if (this.lastLoopStartedAt !== null) {
                const periodMs = loopStart - this.lastLoopStartedAt;
                if (periodMs > 0) {
                    const instantFps = 1000 / periodMs;
                    this.detectionFps = this.detectionFps === 0
                        ? instantFps
                        : this.detectionFps + FPS_EMA_ALPHA * (instantFps - this.detectionFps);
                }
            }
            this.lastLoopStartedAt = loopStart;
        }

        this.scheduleNextFrame(videoElement, performance.now() - loopStart);
    }

    /** Cadência REAL de detecção (quadros/s), média exponencial. 0 quando parado. */
    public getDetectionFps(): number {
        return this.detectionFps;
    }

    /** Custo do último passo de detecção em ms — o orçamento que a cadencia consome. */
    public getLastDetectMs(): number {
        return this.lastDetectMs;
    }

    public startDetection(videoElement: HTMLVideoElement): void {
        this.cancelLoop();
        this.isDetecting = true;
        this.detectionFps = 0;
        this.lastLoopStartedAt = null;
        detectionEngine.reset();
        wsClient.sendEvent(EventType.FACE_DETECTED);
        this.runDetectionLoop(videoElement);
    }

    public stopDetection(): void {
        this.cancelLoop();
        this.isDetecting = false;
        this.detectionFps = 0;
        this.lastDetectMs = 0;
        this.lastLoopStartedAt = null;
        wsClient.sendEvent(EventType.FACE_LOST);
    }

    /**
     * Libera o FaceLandmarker (memória WASM do MediaPipe).
     * O modelo pode ser reinicializado depois via initialize() se necessário.
     */
    public async releaseModel(): Promise<void> {
        this.stopDetection();
        if (this.faceLandmarker) {
            try {
                this.faceLandmarker.close();
            } catch {
                // close() pode lançar se já foi fechado
            }
            this.faceLandmarker = null;
            this.initializing = null;
            console.log("MediaPipe FaceLandmarker liberado.");
        }
    }
}

export const mediaPipeManager = new MediaPipeManager();
