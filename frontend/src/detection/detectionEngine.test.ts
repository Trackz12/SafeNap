import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DetectionEngine } from './detectionEngine';
import { metricsStore } from './metricsStore';
import { calibrationManager } from '../safety/calibrationManager';

describe('DetectionEngine presets', () => {
    let engine: DetectionEngine;

    beforeEach(() => {
        engine = new DetectionEngine();
    });

    it('defaults to standard preset', () => {
        expect(engine.getPreset()).toBe('standard');
        expect(engine.getState()).toBe('NORMAL');
    });

    it('setPreset changes the active preset', () => {
        engine.setPreset('lenient');
        expect(engine.getPreset()).toBe('lenient');

        engine.setPreset('strict');
        expect(engine.getPreset()).toBe('strict');
    });

    it('getMode defaults to hybrid', () => {
        expect(engine.getMode()).toBe('hybrid');
    });

    it('setMode and getMode round-trip', () => {
        engine.setMode('rules');
        expect(engine.getMode()).toBe('rules');
        engine.setMode('ml');
        expect(engine.getMode()).toBe('ml');
    });

    it('reset returns to NORMAL state and clears reason', () => {
        // Force a non-normal state by publishing metrics (if engine listens)
        // Since engineer logic relies on processFrame, just verify reset clears.
        engine.setPreset('strict');
        engine.reset();
        expect(engine.getState()).toBe('NORMAL');
        expect(engine.getPreset()).toBe('strict'); // preset not reset by reset()
    });
});

describe('DetectionEngine state via calibration + metrics', () => {
    let engine: DetectionEngine;

    beforeEach(() => {
        // Reset module-level calibration to a clean, default threshold
        calibrationManager.clearCalibration();
        calibrationManager.skipWithDefault(); // enables canEvaluate() without camera
        metricsStore.reset();
        engine = new DetectionEngine();
    });

    afterEach(() => {
        calibrationManager.clearCalibration();
        metricsStore.reset();
    });

    it('publishes NORMAL metrics when no frames processed', () => {
        expect(metricsStore.get()).toBeNull();
        // Without processFrame, metricsStore remains empty (no publish yet)
        expect(engine.getState()).toBe('NORMAL');
    });

    it('ackAlarm resets state to NORMAL and publishes', () => {
        engine.ackAlarm();
        expect(engine.getState()).toBe('NORMAL');
        // ackAlarm publishes DEFAULT_METRICS via publishLastFrame
        const m = metricsStore.get();
        expect(m).not.toBeNull();
        expect(m?.state).toBe('NORMAL');
    });

    it('can evaluate when calibration is skipped', () => {
        expect(calibrationManager.canEvaluate()).toBe(true);
    });
});