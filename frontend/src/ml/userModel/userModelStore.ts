import { NUM_FEATURES } from '../featureOrder';
import type { UserRF } from './randomForest';
import { trainUserRF, predictUserRF, validateUserRF } from './randomForest';

// v2: v1 codificava "sem piscada" como 0; agora é -1 (featureVectorToArray). Dados/modelo v1
// misturariam duas codificações, então são descartados (o modelo do usuário é retreinável).
const STORAGE_KEY = 'safenap_ml_user_data_v2';
const MODEL_KEY = 'safenap_ml_user_model_v2';
const LEGACY_KEYS = ['safenap_ml_user_data_v1', 'safenap_ml_user_model_v1'];
const MIN_SAMPLES_PER_CLASS = 50;

interface Sample {
    features: number[];
    label: 0 | 1;
    collectedAt: number;
}

type Listener = () => void;
const listeners = new Set<Listener>();

let samples: Sample[] = [];
let model: UserRF | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

function notify(): void {
    for (const cb of listeners) cb();
}

function isValidSample(s: unknown): s is Sample {
    if (typeof s !== 'object' || s === null) return false;
    const x = s as Partial<Sample>;
    return (x.label === 0 || x.label === 1) && Array.isArray(x.features)
        && x.features.length === NUM_FEATURES
        && x.features.every((v) => typeof v === 'number' && Number.isFinite(v));
}

function loadSamples(): Sample[] {
    try {
        for (const k of LEGACY_KEYS) localStorage.removeItem(k);
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(isValidSample) : [];
    } catch {
        return [];
    }
}

/** Salva no máximo 1x por segundo para não bloquear a main thread com I/O. */
function scheduleSave(): void {
    dirty = true;
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        if (!dirty) return;
        dirty = false;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(samples));
        } catch {
            // ignore
        }
    }, 1000);
}

function saveSamplesNow(): void {
    if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
    dirty = false;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(samples));
    } catch {
        // ignore
    }
}

function loadModel(): UserRF | null {
    try {
        const raw = localStorage.getItem(MODEL_KEY);
        return raw ? validateUserRF(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

function saveModel(m: UserRF): void {
    try {
        localStorage.setItem(MODEL_KEY, JSON.stringify(m));
    } catch {
        // ignore
    }
}

samples = loadSamples();
model = loadModel();

export const userModelStore = {
    subscribe(cb: Listener): () => void {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
    },

    getSampleCount(): number {
        return samples.length;
    },

    getAlertCount(): number {
        return samples.filter((s) => s.label === 0).length;
    },

    getDrowsyCount(): number {
        return samples.filter((s) => s.label === 1).length;
    },

    addSample(features: number[], label: 0 | 1): void {
        if (!isValidSample({ features, label, collectedAt: 0 })) return;
        samples.push({ features, label, collectedAt: Date.now() });
        scheduleSave();
        notify();
    },

    canTrain(): boolean {
        return samples.filter((s) => s.label === 0).length >= MIN_SAMPLES_PER_CLASS
            && samples.filter((s) => s.label === 1).length >= MIN_SAMPLES_PER_CLASS;
    },

    train(): UserRF | null {
        if (!this.canTrain()) return null;
        const X = samples.map((s) => s.features);
        const y = samples.map((s) => s.label);
        const result = trainUserRF(X, y);
        if (result) {
            model = result;
            saveModel(model);
            notify();
        }
        return model;
    },

    getModel(): UserRF | null {
        return model;
    },

    /**
     * Aplica um modelo RF treinado recebido de outro device via sync.
     * Não treina nem reescreve amostras locais; apenas adota o modelo
     * compartilhado para que o viewer use o mesmo classificador.
     */
    applyRemoteModel(remote: UserRF): void {
        const valid = validateUserRF(remote);
        if (!valid) return;
        if (!model || valid.trainedAt > model.trainedAt) {
            model = valid;
            saveModel(model);
            notify();
        }
    },

    predict(features: number[]): number | null {
        if (!model) return null;
        return predictUserRF(model, features);
    },

    clearSamples(): void {
        samples = [];
        saveSamplesNow();
        notify();
    },

    clearModel(): void {
        model = null;
        try {
            localStorage.removeItem(MODEL_KEY);
        } catch {
            // ignore
        }
        notify();
    },

    clearAll(): void {
        this.clearSamples();
        this.clearModel();
    },
};
