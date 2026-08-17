import { NUM_FEATURES } from '../featureOrder';
import type { UserRF } from './randomForest';
import { trainUserRF, predictUserRF } from './randomForest';

const STORAGE_KEY = 'safenap_ml_user_data_v1';
const MODEL_KEY = 'safenap_ml_user_model_v1';
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

function loadSamples(): Sample[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
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
        return raw ? JSON.parse(raw) : null;
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
        if (features.length !== NUM_FEATURES) return;
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
        if (!remote || !Array.isArray(remote.trees)) return;
        if (!model || remote.trainedAt > model.trainedAt) {
            model = remote;
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
