import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MlTrainingCard } from './MlTrainingCard';

const render = () => renderToStaticMarkup(createElement(MlTrainingCard));

describe('MlTrainingCard — recurso experimental atrás de VITE_ENABLE_USER_MODEL', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('modo normal: não renderiza nada (não sugere que o modelo do usuário detecta)', () => {
        expect(render()).toBe('');
    });

    it('flag desligado explicitamente também não renderiza', () => {
        vi.stubEnv('VITE_ENABLE_USER_MODEL', 'false');
        expect(render()).toBe('');
    });

    it('modo experimental: renderiza e se declara Experimental', () => {
        vi.stubEnv('VITE_ENABLE_USER_MODEL', 'true');
        const html = render();
        expect(html).toContain('Treinamento ML');
        expect(html).toContain('Experimental');
    });
});
