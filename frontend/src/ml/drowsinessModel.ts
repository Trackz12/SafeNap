import type { FeatureVector } from '../detection/featureExtractor';
import { vectorToTensor } from './vectorToTensor';
import { modelStatusStore } from './modelStatusStore';
import { INFERENCE_INTERVAL_MS, SMOOTHING_WINDOW } from './thresholds';
import { userModelStore } from './userModel/userModelStore';
import { FEATURE_ORDER } from './featureOrder';

type ORT = typeof import('onnxruntime-web');

export interface InferenceSession {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run(feeds: Record<string, unknown>): Promise<Record<string, any>>;
}

let ortModule: ORT | null = null;

async function loadORT(): Promise<ORT> {
    if (ortModule) return ortModule;
    ortModule = await import('onnxruntime-web');
    return ortModule;
}

const LOCAL_MODEL_PATH = '/models/drowsiness.onnx';
const CDN_WASM_PATH = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const CDN_MODEL_PATH = 'https://unpkg.com/@lucas/safenap-drowsiness-model@latest/drowsiness.onnx';

async function fetchExists(url: string): Promise<boolean> {
    try {
        const res = await fetch(url, { method: 'HEAD' });
        return res.ok;
    } catch {
        return false;
    }
}

export interface MLResult {
    score: number | null;
    at: number | null;
}

class DrowsinessModel {
    private session: InferenceSession | null = null;
    private initializing: Promise<void> | null = null;
    private lastResult: MLResult = { score: null, at: null };
    private lastInferenceAt = 0;
    private busy = false;
    private scoreBuffer: number[] = [];

    public async initialize(): Promise<void> {
        if (this.session) return;
        if (this.initializing) return this.initializing;

        modelStatusStore.setStatus('loading');

        this.initializing = (async () => {
            try {
                const ort = await loadORT();

                let modelPath = LOCAL_MODEL_PATH;

                if (!(await fetchExists(LOCAL_MODEL_PATH))) {
                    console.warn('Modelo ONNX local não encontrado; usando CDN como fallback.');
                    modelPath = CDN_MODEL_PATH;
                }

                ort.env.wasm.wasmPaths = CDN_WASM_PATH;

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                this.session = await (ort.InferenceSession as any).create(modelPath, {
                    executionProviders: ['wasm'],
                    graphOptimizationLevel: 'all',
                });

                // Warmup com tensor dummy
                const dummy = new ort.Tensor('float32', new Float32Array(18), [1, 18]);
                await this.session!.run({ features: dummy });
                try { dummy.dispose(); } catch { /* ok */ }

                modelStatusStore.setStatus('ready');
                console.log('Modelo de sonolência ONNX carregado!');
            } catch (err) {
                this.initializing = null;
                const msg = err instanceof Error ? err.message : String(err);
                modelStatusStore.setStatus('error', msg);
                console.warn('Falha ao carregar modelo ONNX:', msg);
            }
        })();

        return this.initializing;
    }

    public inferAsync(fv: FeatureVector, now: number): void {
        if (this.busy) return;
        if (now - this.lastInferenceAt < INFERENCE_INTERVAL_MS) return;

        // Prioridade: modelo do usuario > ONNX
        const features = FEATURE_ORDER.map((k) => (fv as unknown as Record<string, number>)[k]);
        const userScore = userModelStore.predict(features);
        if (userScore !== null) {
            this.scoreBuffer.push(userScore);
            if (this.scoreBuffer.length > SMOOTHING_WINDOW) this.scoreBuffer.shift();
            const sorted = [...this.scoreBuffer].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            this.lastResult = {
                score: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
                at: Date.now(),
            };
            this.lastInferenceAt = now;
            return;
        }

        // Fallback: modelo ONNX
        if (!this.session) return;
        const tensor = vectorToTensor(fv);
        if (!tensor) return;

        this.busy = true;
        this.lastInferenceAt = now;

        void loadORT().then((ort) => {
            const input = new ort.Tensor('float32', tensor, [1, 18]);
            return this.session!.run({ features: input }).then((results) => {
                // Libera o tensor de input imediatamente após o run
                try { input.dispose(); } catch { /* ok */ }

                const output = results['probabilities'];
                if (output && output.data.length >= 2) {
                    const probDrowsy = (output.data as Float32Array)[1];
                    this.scoreBuffer.push(probDrowsy);
                    if (this.scoreBuffer.length > SMOOTHING_WINDOW) this.scoreBuffer.shift();
                    const sorted = [...this.scoreBuffer].sort((a, b) => a - b);
                    const mid = Math.floor(sorted.length / 2);
                    const smoothed = sorted.length % 2
                        ? sorted[mid]
                        : (sorted[mid - 1] + sorted[mid]) / 2;
                    this.lastResult = { score: smoothed, at: Date.now() };
                }

                // Libera o tensor de output
                try { output?.dispose?.(); } catch { /* ok */ }

                this.busy = false;
            });
        }).catch(() => {
            this.busy = false;
        });
    }

    public getLastScore(): MLResult {
        return this.lastResult;
    }

    public reset(): void {
        this.lastResult = { score: null, at: null };
        this.scoreBuffer = [];
        this.lastInferenceAt = 0;
        this.busy = false;
    }

    public isReady(): boolean {
        return this.session !== null;
    }
}

export const drowsinessModel = new DrowsinessModel();
