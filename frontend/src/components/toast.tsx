import { useEffect, useState } from 'react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
    id: number;
    message: string;
    type: ToastType;
}

let nextId = 0;
let listeners: Array<() => void> = [];
let toasts: Toast[] = [];

function notify(): void {
    for (const l of listeners) l();
}

function remove(id: number): void {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
}

function push(message: string, type: ToastType = 'info', durationMs = 3000): void {
    const id = ++nextId;
    toasts = [...toasts, { id, message, type }];
    notify();
    setTimeout(() => remove(id), durationMs);
}

export const toast = {
    success: (msg: string) => push(msg, 'success'),
    error: (msg: string) => push(msg, 'error', 5000),
    info: (msg: string) => push(msg, 'info'),
    warning: (msg: string) => push(msg, 'warning'),
    // Hook interno para o componente consumir — não chamar de componentes React.
    __subscribe(cb: () => void): () => void {
        listeners.push(cb);
        return () => { listeners = listeners.filter((l) => l !== cb); };
    },
    __getToasts(): Toast[] {
        return toasts;
    },
    __clear(): void {
        toasts = [];
        notify();
    },
};

/** Hook React para ler os toasts atuais (usado pelo ToastContainer). */
export function useToasts(): Toast[] {
    const [, setCount] = useState(0);
    useEffect(() => {
        return toast.__subscribe(() => setCount((n) => n + 1));
    }, []);
    return toast.__getToasts();
}