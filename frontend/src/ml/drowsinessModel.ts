import type { FeatureVector } from '../detection/featureExtractor';
import { featureVectorToArray } from './vectorToTensor';
import { modelStatusStore } from './modelStatusStore';
import {
    INFERENCE_INTERVAL_MS,
    INFERENCE_TIMEOUT_MS,
    MAX_CONSECUTIVE_FAILURES,
    SMOOTHING_WINDOW,
} from './thresholds';
import { userModelStore } from './userModel/userModelStore';
import { NUM_FEATURES } from './featureOrder';
import { medianFilter } from './smoothing';

// Runtime WASM empacotado pelo Vite a partir do pacote instalado (`?url`): mesmo origin, offline,
// versão sempre igual à do JS. Não passa por /public (o dev server do Vite recusa JS de /public).
import ortWasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import ortMjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';

type ORT = typeof import('onnxruntime-web');

export interface InferenceSession {
    readonly inputNames?: readonly string[];
    readonly outputNames?: readonly string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run(feeds: Record<string, unknown>): Promise<Record<string, any>>;
}

let ortModule: ORT | null = null;

async function loadORT(): Promise<ORT> {
    if (ortModule) return ortModule;
    ortModule = await import('onnxruntime-web/wasm'); // só backend WASM (sem WebGPU/jsep)
    return ortModule;
}

const LOCAL_MODEL_PATH = '/models/drowsiness.onnx';
/** Contrato do ONNX exportado por skl2onnx (ver ml/scripts): saída de probabilidades por classe. */
const OUTPUT_PROBABILITIES = 'probabilities';
/** classlabels = [0, 1] → índice 1 é a classe DROWSY. Validado em ml/tests (contrato do modelo). */
const DROWSY_CLASS_INDEX = 1;

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
    private ort: ORT | null = null;
    private inputName = 'features';
    private initializing: Promise<void> | null = null;
    private lastResult: MLResult = { score: null, at: null };
    private lastInferenceAt = 0;
    /** Uma inferência ONNX em voo por vez (o ORT não deve receber run() concorrentes). */
    private inFlight = false;
    /**
     * Geração dos resultados. Incrementada em reset()/timeout: um resultado que
     * volta de uma inferência iniciada em geração anterior é descartado.
     */
    private epoch = 0;
    private consecutiveFailures = 0;
    private scoreBuffer: number[] = [];

    public async initialize(): Promise<void> {
        if (this.session) return;
        if (this.initializing) return this.initializing;

        modelStatusStore.setStatus('loading');

        this.initializing = (async () => {
            try {
                const ort = await loadORT();

                if (!(await fetchExists(LOCAL_MODEL_PATH))) {
                    // Sem fallback para modelo de terceiros (CDN): executar um
                    // modelo não versionado neste repositório é risco de supply chain.
                    throw new Error(`Modelo ONNX ausente em ${LOCAL_MODEL_PATH}`);
                }

                // WASM do mesmo origin: sem código de terceiros em runtime (a página tem câmera).
                if (!(await fetchExists(ortWasmUrl))) {
                    throw new Error(`Runtime WASM do ORT indisponível em ${ortWasmUrl}`);
                }
                ort.env.wasm.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl };

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const session = await (ort.InferenceSession as any).create(LOCAL_MODEL_PATH, {
                    executionProviders: ['wasm'],
                    graphOptimizationLevel: 'all',
                }) as InferenceSession;

                if (session.outputNames && !session.outputNames.includes(OUTPUT_PROBABILITIES)) {
                    throw new Error(`Modelo sem saída '${OUTPUT_PROBABILITIES}' (saídas: ${session.outputNames.join(', ')})`);
                }
                this.inputName = session.inputNames?.[0] ?? this.inputName;

                // Warmup: também valida shape [1, NUM_FEATURES] e o formato da saída.
                const dummy = new ort.Tensor('float32', new Float32Array(NUM_FEATURES), [1, NUM_FEATURES]);
                const warm = await session.run({ [this.inputName]: dummy });
                try { dummy.dispose(); } catch { /* ok */ }
                const probs = warm[OUTPUT_PROBABILITIES]?.data;
                if (!probs || probs.length < 2) {
                    throw new Error('Saída de probabilidades inválida no warmup do modelo');
                }

                this.ort = ort;
                this.session = session;
                this.consecutiveFailures = 0;
                modelStatusStore.setStatus('ready');
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
        if (this.inFlight) return;
        if (now - this.lastInferenceAt < INFERENCE_INTERVAL_MS) return;

        // Vetor inválido (NaN/Infinity) nunca vira score, em nenhum dos caminhos.
        const features = featureVectorToArray(fv);
        if (!features) return;

        // Prioridade: modelo do usuário > ONNX
        const userScore = userModelStore.predict(features);
        if (userScore !== null) {
            this.lastInferenceAt = now;
            this.publishScore(userScore);
            return;
        }

        // Fallback: modelo ONNX
        if (!this.session || !this.ort) return;

        this.inFlight = true;
        this.lastInferenceAt = now;
        void this.runOnnx(this.session, this.ort, features, this.epoch).finally(() => {
            this.inFlight = false;
        });
    }

    private async runOnnx(session: InferenceSession, ort: ORT, features: number[], epoch: number): Promise<void> {
        const input = new ort.Tensor('float32', Float32Array.from(features), [1, NUM_FEATURES]);
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            this.epoch++; // descarta qualquer resultado tardio
            // Um run() travado mantém `inFlight` (sem run() concorrente) e desativa o ONNX
            // nesta sessão: reportar erro já, para a UI não mostrar "pronto" com score velho.
            this.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
            this.recordFailure(new Error(`inferência excedeu ${INFERENCE_TIMEOUT_MS}ms`));
        }, INFERENCE_TIMEOUT_MS);

        try {
            const results = await session.run({ [this.inputName]: input });
            if (timedOut) return;

            const output = results[OUTPUT_PROBABILITIES];
            const prob = output?.data && output.data.length >= 2
                ? Number(output.data[DROWSY_CLASS_INDEX])
                : NaN;
            try { output?.dispose?.(); } catch { /* ok */ }

            if (!Number.isFinite(prob) || prob < 0 || prob > 1) {
                throw new Error('probabilidade fora de [0,1] ou saída ausente');
            }
            if (epoch === this.epoch) this.publishScore(prob);
            this.recordSuccess();
        } catch (err) {
            if (!timedOut) this.recordFailure(err);
        } finally {
            clearTimeout(timer);
            try { input.dispose(); } catch { /* ok */ }
        }
    }

    private publishScore(raw: number): void {
        this.scoreBuffer.push(raw);
        if (this.scoreBuffer.length > SMOOTHING_WINDOW) this.scoreBuffer.shift();
        this.lastResult = { score: medianFilter(this.scoreBuffer), at: Date.now() };
    }

    private recordSuccess(): void {
        this.consecutiveFailures = 0;
        if (modelStatusStore.getStatus() === 'error') modelStatusStore.setStatus('ready');
    }

    private recordFailure(err: unknown): void {
        this.consecutiveFailures++;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Falha na inferência ONNX (${this.consecutiveFailures}):`, msg);
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            modelStatusStore.setStatus('error', msg);
        }
    }

    public getLastScore(): MLResult {
        return this.lastResult;
    }

    /**
     * Limpa score e suavização. NÃO libera `inFlight`: uma inferência em voo
     * termina sozinha e seu resultado é descartado pela troca de geração.
     */
    public reset(): void {
        this.epoch++;
        this.lastResult = { score: null, at: null };
        this.scoreBuffer = [];
        this.lastInferenceAt = 0;
    }

    public isReady(): boolean {
        return this.session !== null;
    }
}

export const drowsinessModel = new DrowsinessModel();
export { DrowsinessModel };
