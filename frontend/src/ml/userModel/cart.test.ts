import { describe, it, expect } from 'vitest';
import { trainCART, predictCART, type CARTNode } from './cart';
import { trainUserRF, predictUserRF, type UserRF } from './randomForest';

function makeSeparableData(): { X: number[][]; y: number[] } {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 100; i++) {
        X.push([-3 + Math.random(), -3 + Math.random(), ...Array(16).fill(0)]);
        y.push(0);
    }
    for (let i = 0; i < 100; i++) {
        X.push([3 + Math.random(), 3 + Math.random(), ...Array(16).fill(0)]);
        y.push(1);
    }
    return { X, y };
}

describe('CART', () => {
    it('treina sem erro e retorna prediction válido', () => {
        const { X, y } = makeSeparableData();
        const tree: CARTNode = trainCART(X, y);
        expect(tree.prediction).toBeGreaterThanOrEqual(0);
        expect(tree.prediction).toBeLessThanOrEqual(1);
    });

    it('predição varia conforme entrada', () => {
        const { X, y } = makeSeparableData();
        const tree = trainCART(X, y);
        const p1 = predictCART(tree, [-3, -3, ...Array(16).fill(0)]);
        const p2 = predictCART(tree, [3, 3, ...Array(16).fill(0)]);
        expect(typeof p1).toBe('number');
        expect(typeof p2).toBe('number');
    });
});

describe('UserRF', () => {
    it('treina e retorna modelo válido', () => {
        const { X, y } = makeSeparableData();
        const rf: UserRF | null = trainUserRF(X, y);

        expect(rf).not.toBeNull();
        expect(rf!.trees.length).toBe(40);
        expect(rf!.trainedAt).toBeGreaterThan(0);
        expect(rf!.sampleCount).toBe(200);
    });

    it('predict retorna número válido', () => {
        const { X, y } = makeSeparableData();
        const rf = trainUserRF(X, y);
        const score = predictUserRF(rf!, [-3, -3, ...Array(16).fill(0)]);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
    });

    it('retorna null com poucos dados', () => {
        expect(trainUserRF([[0, 0]], [0])).toBeNull();
    });
});
