/**
 * Clock injetável — desacopla toda a lógica temporal de `Date.now()` direto.
 *
 * Motivo (auditoria de arquitetura, 2026-09-23): `detectionEngine.ts` chamava
 * `Date.now()` diretamente em ~10 pontos diferentes. Os testes contornavam
 * isso mockando o relógio GLOBAL (`vi.useFakeTimers()` + `vi.setSystemTime()`),
 * o que funciona mas é frágil: acopla todo teste a mockar `Date` inteiro (não
 * só o `DetectionEngine`), e não permite dois relógios independentes na mesma
 * suíte. Com `Clock` injetável, um teste passa um `FakeClock` só para o
 * componente sob teste — mesmo padrão já usado no backend
 * (`backend/tests/test_grip_monitor.py::FakeClock`).
 *
 * `now()` usa `Date.now()` (tempo de parede, relevante para timestamps que
 * cruzam a rede/UI). Para medir DURAÇÃO de um evento local (não timestamps
 * absolutos), prefira `performance.now()` em quem consome — não monotônico
 * vs. relógio de parede é uma escolha de quem usa o Clock, não do Clock em
 * si; os detectores deste módulo usam timestamps de parede porque precisam
 * ser comparáveis com os eventos que saem para o WebSocket/backend.
 */
export interface Clock {
    now(): number;
}

export const systemClock: Clock = {
    now: () => Date.now(),
};

/**
 * Relógio controlável para testes. Substitui `vi.useFakeTimers()` +
 * `vi.setSystemTime()` para testar SÓ o componente que recebe este clock,
 * sem mockar `Date` globalmente.
 */
export class FakeClock implements Clock {
    private t: number;

    constructor(startAt = 0) {
        this.t = startAt;
    }

    public now(): number {
        return this.t;
    }

    public advance(ms: number): void {
        this.t += ms;
    }

    public set(t: number): void {
        this.t = t;
    }
}
