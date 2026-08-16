type Listener = () => void;

/**
 * Papel do device nesta sessão multi-dispositivo.
 *  - none: ainda não reivindicou papel (aguarda câmera / claim)
 *  - detector: este device roda a câmera e publica métricas
 *  - viewer: espelha o estado publicado por outro device (sem câmera)
 */
export type DeviceRole = 'none' | 'detector' | 'viewer';

const listeners = new Set<Listener>();

let role: DeviceRole = 'none';
/** session_id do detector ativo (pode ser este device ou outro). */
let detectorOwner: string | null = null;

export const roleStore = {
    getRole(): DeviceRole {
        return role;
    },

    getDetectorOwner(): string | null {
        return detectorOwner;
    },

    setRole(value: DeviceRole): void {
        if (role === value) return;
        role = value;
        for (const cb of listeners) cb();
    },

    setDetectorOwner(owner: string | null): void {
        if (detectorOwner === owner) return;
        detectorOwner = owner;
        for (const cb of listeners) cb();
    },

    subscribe(cb: Listener): () => void {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
    },
};
