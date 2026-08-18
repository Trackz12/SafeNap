import { describe, it, expect } from 'vitest';
import { combineEyes } from './frameAnalyzer';

describe('combineEyes', () => {
    it('returns average when both eyes agree and yaw is zero', () => {
        expect(combineEyes(0.3, 0.3, 0)).toBeCloseTo(0.3, 4);
    });

    it('returns average when both eyes are slightly different', () => {
        const result = combineEyes(0.28, 0.32, 0);
        expect(result).toBeCloseTo(0.3, 2);
    });

    it('returns higher eye when disagreement is large (frontal)', () => {
        // lo/hi = 0.1/0.35 = 0.286 < 0.55 → confia no hi
        const result = combineEyes(0.1, 0.35, 0);
        expect(result).toBeCloseTo(0.35, 4);
    });

    it('returns higher eye when disagreement is large (reversed args)', () => {
        const result = combineEyes(0.35, 0.1, 0);
        expect(result).toBeCloseTo(0.35, 4);
    });

    it('blends toward hi in profile pose (yaw=0.5)', () => {
        // absYaw=0.5 > 0.25, yawFactor = min(1, (0.5-0.25)/0.35) ≈ 0.714
        // frontEar=0.3, profileEar=0.35
        // result = 0.3*(1-0.714) + 0.35*0.714 ≈ 0.0858 + 0.25 = 0.336
        const result = combineEyes(0.25, 0.35, 0.5);
        expect(result).toBeGreaterThan(0.30);
        expect(result).toBeLessThan(0.36);
    });

    it('fully trusts hi in strong profile (yaw=0.7)', () => {
        // absYaw=0.7 > 0.25, yawFactor = min(1, (0.7-0.25)/0.35) = 1.0
        // result = profileEar = 0.35
        const result = combineEyes(0.1, 0.35, 0.7);
        expect(result).toBeCloseTo(0.35, 4);
    });

    it('handles negative yaw the same as positive', () => {
        const pos = combineEyes(0.25, 0.35, 0.5);
        const neg = combineEyes(0.25, 0.35, -0.5);
        expect(pos).toBeCloseTo(neg, 10);
    });

    it('handles zero EAR gracefully', () => {
        expect(combineEyes(0, 0, 0)).toBe(0);
    });

    it('handles very small EAR values', () => {
        const result = combineEyes(0.01, 0.012, 0);
        expect(result).toBeGreaterThan(0);
        expect(result).toBeLessThan(0.05);
    });
});
