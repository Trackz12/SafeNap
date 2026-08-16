type ModelStatus = 'idle' | 'loading' | 'ready' | 'error';
type Listener = () => void;

const listeners = new Set<Listener>();
let status: ModelStatus = 'idle';
let errorMessage: string | null = null;

export const modelStatusStore = {
    setStatus(value: ModelStatus, error?: string): void {
        if (status === value && errorMessage === (error ?? null)) return;
        status = value;
        errorMessage = error ?? null;
        for (const cb of listeners) cb();
    },

    getStatus(): ModelStatus {
        return status;
    },

    getError(): string | null {
        return errorMessage;
    },

    subscribe(cb: Listener): () => void {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
    },
};

export type { ModelStatus };
