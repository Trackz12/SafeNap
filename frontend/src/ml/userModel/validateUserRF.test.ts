import { describe, it, expect } from 'vitest';
import { validateUserRF } from './randomForest';
import { userModelStore } from './userModelStore';
import { NUM_FEATURES } from '../featureOrder';

const leaf = (p: number) => ({ prediction: p, count: 5 });
const goodTree = { featureIndex: 0, threshold: 0.2, left: leaf(1), right: leaf(0), prediction: 0.5, count: 10 };
const good = () => ({ version: 1, trees: [goodTree], trainedAt: Date.now() - 1000, sampleCount: 100 });

function deep(n: number): unknown {
    let node: Record<string, unknown> = leaf(0.5);
    for (let i = 0; i < n; i++) node = { featureIndex: 1, threshold: 0.1, left: node, right: leaf(0), prediction: 0.5 };
    return node;
}

describe('validateUserRF (modelo remoto/persistido não é confiável)', () => {
    it('aceita um modelo bem formado', () => {
        expect(validateUserRF(good())).not.toBeNull();
    });

    it.each([
        ['sem árvores (soma/0 = NaN)', { ...good(), trees: [] }],
        ['árvores demais', { ...good(), trees: Array.from({ length: 500 }, () => goodTree) }],
        ['profundidade excessiva (estouro de pilha)', { ...good(), trees: [deep(5000)] }],
        ['featureIndex fora do schema', { ...good(), trees: [{ ...goodTree, featureIndex: NUM_FEATURES }] }],
        ['featureIndex não inteiro', { ...good(), trees: [{ ...goodTree, featureIndex: 0.5 }] }],
        ['threshold NaN', { ...good(), trees: [{ ...goodTree, threshold: NaN }] }],
        ['folha com prediction fora de [0,1]', { ...good(), trees: [{ ...goodTree, left: leaf(7) }] }],
        ['nó interno sem filho', { ...good(), trees: [{ ...goodTree, right: undefined }] }],
        ['trainedAt no futuro distante (fixa o modelo)', { ...good(), trainedAt: 9e15 }],
        ['trainedAt não numérico', { ...good(), trainedAt: 'x' }],
        ['não é objeto', 42],
        ['null', null],
    ])('rejeita: %s', (_name, model) => {
        expect(validateUserRF(model)).toBeNull();
    });

    it('applyRemoteModel ignora modelo inválido e mantém o atual', () => {
        userModelStore.clearModel();
        userModelStore.applyRemoteModel({ trees: [], trainedAt: Date.now(), version: 1, sampleCount: 1 });
        expect(userModelStore.getModel()).toBeNull();
        userModelStore.applyRemoteModel(good());
        expect(userModelStore.getModel()).not.toBeNull();
        userModelStore.clearModel();
    });

    it('addSample rejeita NaN/Infinity e rótulo inválido', () => {
        userModelStore.clearSamples();
        const ok = new Array(NUM_FEATURES).fill(0.3);
        userModelStore.addSample([...ok.slice(1), NaN], 0);
        userModelStore.addSample([...ok.slice(1), Infinity], 1);
        userModelStore.addSample(ok, 2 as unknown as 0);
        expect(userModelStore.getSampleCount()).toBe(0);
        userModelStore.addSample(ok, 1);
        expect(userModelStore.getSampleCount()).toBe(1);
        userModelStore.clearSamples();
    });
});
