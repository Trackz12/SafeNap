type Listener = () => void;

const listeners = new Set<Listener>();
let active = false;

export const cameraStatusStore = {
    setActive(value: boolean): void {
        if (active === value) return;
        active = value;
        for (const cb of listeners) cb();
    },

    isActive(): boolean {
        return active;
    },

    subscribe(cb: Listener): () => void {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
    },
};
