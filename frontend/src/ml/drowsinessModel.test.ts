import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FeatureVector } from '../detection/featureExtractor';
import { FEATURE_ORDER } from './featureOrder';
import { modelStatusStore } from './modelStatusStore';
import { userModelStore } from './userModel/userModelStore';
import {
    INFERENCE_INTERVAL_MS,
    INFERENCE_TIMEOUT_MS,
    MAX_CONSECUTIVE_FAILURES,
} from './thresholds';

// O runtime WASM real não roda em Node sem o binário; aqui mockamos APENAS a
// fronteira ORT para testar o controle de fluxo (throttle, descarte, falha,
// timeout, fallback). O contrato do ONNX real (shape, saídas, classes) é
// verificado contra o arquivo de verdade em ml/tests/test_model_contract.py.
const h = vi.hoisted(() => ({
    create: vi.fn(),
    env: { wasm: {} as Record<string, unknown>, versions: { web: '9.9.9' } },
}));
vi.mock('onnxruntime-web', () => {
    class Tensor {
        type: string;
        data: Float32Array;
        dims: number[];
        constructor(type: string, data: Float32Array, dims: number[]) {
            this.type = type;
            this.data = data;
            this.dims = dims;
        }
        dispose(): void {}
    }
    return { Tensor, env: h.env, InferenceSession: { create: h.create } };
});

import { DrowsinessModel } from './drowsinessModel';

function fv(overrides: Partial<FeatureVector> = {}): FeatureVector {
    const base: Record<string, number> = {};
    for (const k of FEATURE_ORDER) base[k] = 0.3;
    return {
        ...(base as unknown as FeatureVector),
        msSinceLastBlink: 1000, windowSize: 10, windowDurationMs: 900, extractedAt: 0,
        ...overrides,
    };
}

const probs = (p: number) => ({ probabilities: { data: new Float32Array([1 - p, p]), dispose() {} } });

interface MockSession {
    inputNames: string[];
    outputNames: string[];
    run: ReturnType<typeof vi.fn>;
}
/** A 1ª chamada de run() é o warmup do initialize() e sempre é válida; `run` custom vale depois. */
function makeSession(run?: (feeds: Record<string, unknown>) => Promise<unknown>): MockSession {
    let calls = 0;
    return {
        inputNames: ['features'],
        outputNames: ['label', 'probabilities'],
        run: vi.fn(async (feeds: Record<string, unknown>) =>
            (calls++ === 0 || !run) ? probs(0.5) : run(feeds)),
    };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('DrowsinessModel (inferência ONNX)', () => {
    let model: DrowsinessModel;
    let now: number;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        now = Date.now();
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(userModelStore, 'predict').mockReturnValue(null);
        h.create.mockReset();
        h.env.wasm = {};
        modelStatusStore.setStatus('idle');
        model = new DrowsinessModel();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    async function ready(session = makeSession()): Promise<MockSession> {
        h.create.mockResolvedValue(session);
        await model.initialize();
        session.run.mockClear(); // ignora a chamada de warmup
        return session;
    }

    /** Avança o relógio e dispara uma inferência. */
    function infer(vec = fv(), advanceMs = INFERENCE_INTERVAL_MS): void {
        vi.setSystemTime(Date.now() + advanceMs);
        now = Date.now();
        model.inferAsync(vec, now);
    }

    describe('carregamento', () => {
        it('inicializa, valida a saída no warmup e fica ready; alinha o WASM à versão instalada', async () => {
            await ready();
            expect(model.isReady()).toBe(true);
            expect(modelStatusStore.getStatus()).toBe('ready');
            expect(String(h.env.wasm.wasmPaths)).toContain('onnxruntime-web@9.9.9');
        });

        it('modelo local ausente → status error, sem fallback para CDN, sem lançar', async () => {
            vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
            await expect(model.initialize()).resolves.toBeUndefined();
            expect(model.isReady()).toBe(false);
            expect(modelStatusStore.getStatus()).toBe('error');
            expect(h.create).not.toHaveBeenCalled();
        });

        it('falha ao criar a sessão → status error e ML indisponível (score null)', async () => {
            h.create.mockRejectedValue(new Error('wasm falhou'));
            await model.initialize();
            expect(model.isReady()).toBe(false);
            expect(modelStatusStore.getError()).toContain('wasm falhou');
            infer();
            await flush();
            expect(model.getLastScore()).toEqual({ score: null, at: null });
        });

        it('modelo sem a saída "probabilities" é rejeitado', async () => {
            const s = makeSession();
            s.outputNames = ['label'];
            h.create.mockResolvedValue(s);
            await model.initialize();
            expect(model.isReady()).toBe(false);
            expect(modelStatusStore.getStatus()).toBe('error');
        });

        it('warmup com saída malformada é rejeitado', async () => {
            const s = makeSession();
            s.run.mockResolvedValue({ probabilities: { data: new Float32Array([1]) } });
            h.create.mockResolvedValue(s);
            await model.initialize();
            expect(model.isReady()).toBe(false);
        });

        it('pode tentar de novo depois de uma falha de carga', async () => {
            h.create.mockRejectedValueOnce(new Error('rede'));
            await model.initialize();
            expect(model.isReady()).toBe(false);
            h.create.mockResolvedValue(makeSession());
            await model.initialize();
            expect(model.isReady()).toBe(true);
        });
    });

    describe('inferência', () => {
        it('score = probabilidade da classe DROWSY (índice 1), com tensor [1,18] na ordem certa', async () => {
            const s = await ready(makeSession(async () => probs(0.9)));
            infer(fv({ perclos: 0.77 }));
            await flush();
            expect(model.getLastScore().score).toBeCloseTo(0.9, 5);
            const feeds = s.run.mock.calls[0][0] as { features: { dims: number[]; data: Float32Array } };
            expect(feeds.features.dims).toEqual([1, 18]);
            expect(feeds.features.data[FEATURE_ORDER.indexOf('perclos')]).toBeCloseTo(0.77, 5);
        });

        it('respeita o throttle de 200 ms', async () => {
            const s = await ready();
            infer(fv(), INFERENCE_INTERVAL_MS);
            await flush();
            infer(fv(), 50); // < 200 ms depois
            await flush();
            expect(s.run).toHaveBeenCalledTimes(1);
            infer(fv(), INFERENCE_INTERVAL_MS);
            await flush();
            expect(s.run).toHaveBeenCalledTimes(2);
        });

        it('não dispara run() concorrente enquanto há inferência em voo', async () => {
            let resolveRun: (v: unknown) => void = () => {};
            const s = await ready(makeSession(() => new Promise((r) => { resolveRun = r; })));
            infer();
            infer(fv(), 500);
            infer(fv(), 500);
            expect(s.run).toHaveBeenCalledTimes(1);
            resolveRun(probs(0.4));
            await flush();
            infer(fv(), INFERENCE_INTERVAL_MS);
            expect(s.run).toHaveBeenCalledTimes(2);
        });

        it.each([NaN, Infinity])('vetor com %s não gera inferência nem score', async (bad) => {
            const s = await ready();
            infer(fv({ earStdDev: bad }));
            await flush();
            expect(s.run).not.toHaveBeenCalled();
            expect(model.getLastScore().score).toBeNull();
        });

        it('msSinceLastBlink null é enviado como -1 (sentinela)', async () => {
            const s = await ready();
            infer(fv({ msSinceLastBlink: null }));
            await flush();
            const feeds = s.run.mock.calls[0][0] as { features: { data: Float32Array } };
            expect(feeds.features.data[FEATURE_ORDER.indexOf('msSinceLastBlink')]).toBe(-1);
        });

        it('suaviza com mediana de 3 (pico isolado não passa)', async () => {
            const outs = [0.1, 0.99, 0.2];
            let i = 0;
            await ready(makeSession(async () => probs(outs[i++])));
            for (let n = 0; n < 3; n++) { infer(); await flush(); }
            expect(model.getLastScore().score).toBeCloseTo(0.2, 5); // mediana de {0.1, 0.99, 0.2}
        });

        it('sem sessão ONNX e sem modelo do usuário: nenhum score (regras assumem)', () => {
            infer();
            expect(model.getLastScore()).toEqual({ score: null, at: null });
        });

        it('modelo do usuário tem prioridade e dispensa o ONNX', async () => {
            const s = await ready();
            vi.spyOn(userModelStore, 'predict').mockReturnValue(0.7);
            infer();
            await flush();
            expect(model.getLastScore().score).toBeCloseTo(0.7, 5);
            expect(s.run).not.toHaveBeenCalled();
        });
    });

    describe('resultados antigos, falhas e timeout', () => {
        it('reset() durante a inferência em voo descarta o resultado tardio', async () => {
            let resolveRun: (v: unknown) => void = () => {};
            await ready(makeSession(() => new Promise((r) => { resolveRun = r; })));
            infer();
            model.reset(); // ex.: rosto perdido
            resolveRun(probs(0.99));
            await flush();
            expect(model.getLastScore()).toEqual({ score: null, at: null });
        });

        it('probabilidade fora de [0,1] é descartada e conta como falha', async () => {
            await ready(makeSession(async () => probs(1.5)));
            infer();
            await flush();
            expect(model.getLastScore().score).toBeNull();
        });

        it('run() rejeitado não gera score; após N falhas consecutivas o status vira error; um sucesso recupera', async () => {
            let fail = true;
            await ready(makeSession(async () => { if (fail) throw new Error('boom'); return probs(0.3); }));
            for (let n = 0; n < MAX_CONSECUTIVE_FAILURES; n++) { infer(); await flush(); }
            expect(model.getLastScore().score).toBeNull();
            expect(modelStatusStore.getStatus()).toBe('error');

            fail = false;
            infer(); await flush();
            expect(model.getLastScore().score).toBeCloseTo(0.3, 5);
            expect(modelStatusStore.getStatus()).toBe('ready');
        });

        it('inferência que não volta no prazo conta como falha e o resultado tardio é descartado', async () => {
            let resolveRun: (v: unknown) => void = () => {};
            await ready(makeSession(() => new Promise((r) => { resolveRun = r; })));
            infer();
            await vi.advanceTimersByTimeAsync(INFERENCE_TIMEOUT_MS + 1);
            expect(console.warn).toHaveBeenCalled();
            resolveRun(probs(0.99)); // chega tarde demais
            await flush();
            expect(model.getLastScore().score).toBeNull();
        });
    });
});
