import { afterEach, describe, expect, it, vi } from 'vitest';
import { mlDataCollector } from './mlDataCollector';

describe('mlDataCollector — treino automático fora do caminho de segurança', () => {
    afterEach(() => {
        mlDataCollector.stop();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('por padrão start() NÃO agenda auto-treino durante a sessão', () => {
        const spy = vi.spyOn(globalThis, 'setInterval');
        mlDataCollector.start();
        expect(spy).not.toHaveBeenCalled();
    });

    it('modo experimental agenda o auto-treino', () => {
        vi.stubEnv('VITE_ENABLE_USER_MODEL', 'true');
        const spy = vi.spyOn(globalThis, 'setInterval');
        mlDataCollector.start();
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
