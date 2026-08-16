import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { analyzeFrame } from "./frameAnalyzer";
import { detectionEngine } from "../detection/detectionEngine";
import { calibrationManager } from "../safety/calibrationManager";
import { EventType, wsClient } from "../websocket/socketClient";

const LOCAL_WASM_PATH = "/mediapipe/wasm";
const LOCAL_MODEL_PATH = "/mediapipe/models/face_landmarker.task";
const CDN_WASM_PATH = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const CDN_MODEL_PATH = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

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

    constructor() {
        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCanvas.width = 320;
        this.offscreenCanvas.height = 240;
        this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });
        // Leve correção de brilho/contraste para estabilizar landmarks em
        // ambientes escuros ou com back-lighting. Browsers antigos ignoram
        // ctx.filter silenciosamente (fallback seguro).
        if (this.offscreenCtx) {
            this.offscreenCtx.filter = 'brightness(1.06) contrast(1.10)';
        }
    }

    /**
     * Redimensiona o canvas offscreen preservando o aspect ratio do vídeo.
     * Sem isso, um vídeo retrato (celular) era esticado para 4:3 e distorcia
     * os landmarks faciais, quebrando o EAR, o bocejo e a queda de cabeça.
     */
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
        // Prioriza assets auto-hospedados (funciona mesmo sem internet no caminho)
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
                numFaces: 1
            });
            console.log("MediaPipe Inicializado!");
        })().catch((err) => {
            this.initializing = null;
            throw err;
        });

        return this.initializing;
    }

    private async runDetectionLoop(videoElement: HTMLVideoElement) {
        if (!this.faceLandmarker || !this.isDetecting) return;

        if (!videoElement || videoElement.readyState < 3 || videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
            if (this.isDetecting) {
                setTimeout(() => {
                    requestAnimationFrame(() => this.runDetectionLoop(videoElement));
                }, 100);
            }
            return;
        }

        const startTimeMs = performance.now();
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
                        }
                    } else {
                        detectionEngine.processNoFace();
                    }
                }
            } catch (e) {
                console.error("Erro na detecção do MediaPipe:", e);
            }
        }

        // Loop contínuo usando setTimeout para dar respiro à main thread (max ~10 FPS)
        if (this.isDetecting) {
            setTimeout(() => {
                requestAnimationFrame(() => this.runDetectionLoop(videoElement));
            }, 100);
        }
    }

    public startDetection(videoElement: HTMLVideoElement) {
        this.isDetecting = true;
        detectionEngine.reset();
        wsClient.sendEvent(EventType.FACE_DETECTED);
        this.runDetectionLoop(videoElement);
    }

    public stopDetection() {
        this.isDetecting = false;
        wsClient.sendEvent(EventType.FACE_LOST);
    }
}

export const mediaPipeManager = new MediaPipeManager();
