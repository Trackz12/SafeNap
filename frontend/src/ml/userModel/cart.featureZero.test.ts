import { describe, it, expect } from 'vitest';
import { trainCART, predictCART } from './cart';
import { trainUserRF, predictUserRF } from './randomForest';
import { NUM_FEATURES } from '../featureOrder';

/** Dataset separável SOMENTE pela feature 0 ('ear'): baixo → 1 (sonolento), alto → 0. */
function featureZeroDataset(): { X: number[][]; y: number[] } {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 40; i++) {
        const drowsy = i % 2 === 0;
        const row = new Array(NUM_FEATURES).fill(0.5);
        row[0] = drowsy ? 0.1 + i * 0.001 : 0.35 + i * 0.001;
        X.push(row);
        y.push(drowsy ? 1 : 0);
    }
    return { X, y };
}

describe('CART — split na feature de índice 0', () => {
    it('regressão: um nó que divide na feature 0 não pode ser tratado como folha', () => {
        const { X, y } = featureZeroDataset();
        const tree = trainCART(X, y);

        expect(tree.featureIndex).toBe(0); // a raiz realmente divide em 'ear'

        const low = new Array(NUM_FEATURES).fill(0.5); low[0] = 0.1;
        const high = new Array(NUM_FEATURES).fill(0.5); high[0] = 0.4;
        expect(predictCART(tree, low)).toBeGreaterThan(0.9);
        expect(predictCART(tree, high)).toBeLessThan(0.1);
    });

    it('RF sobre dataset separável por feature 0 separa as classes', () => {
        const { X, y } = featureZeroDataset();
        const rf = trainUserRF(X, y)!;
        const low = new Array(NUM_FEATURES).fill(0.5); low[0] = 0.1;
        const high = new Array(NUM_FEATURES).fill(0.5); high[0] = 0.4;
        // Cada árvore só enxerga sqrt(18)=4 features aleatórias, então nem todas
        // conhecem a feature 0; ainda assim a média deve ordenar as classes.
        expect(predictUserRF(rf, low)).toBeGreaterThan(predictUserRF(rf, high));
    });
});
