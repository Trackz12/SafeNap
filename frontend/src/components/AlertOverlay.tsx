import React, { useEffect, useState } from 'react';
import { safetyEngine, type SafetySnapshot } from '../safety/safetyEngine';
import { detectionEngine } from '../detection/detectionEngine';
import { ShieldAlert, ShieldCheck } from 'lucide-react';

const REASON_LABELS: Record<string, string> = {
    EYES_CLOSED_DURATION: 'Olhos fechados por tempo prolongado',
    PERCLOS_CRITICAL: 'Sonolência confirmada (PERCLOS crítico)',
    PERCLOS: 'Fechamentos de olho frequentes',
    YAWN: 'Bocejo detectado',
    HEAD_DROP: 'Cabeça abaixando',
    FACE_LOST: 'Rosto fora do enquadramento',
    PROLONGED_CLOSE: 'Olhos fechados acima do normal',
};

export const AlertOverlay: React.FC = () => {
    const [safety, setSafety] = useState<SafetySnapshot>({ state: 'NORMAL', reason: null });

    useEffect(() => {
        const unsub = safetyEngine.onStateChange((snapshot) => setSafety(snapshot));
        return unsub;
    }, []);

    const isAlarm = safety.state === 'ALARM';
    const isWarning = safety.state === 'WARNING';

    useEffect(() => {
        if (!isAlarm && !isWarning) return;

        let audioCtx: AudioContext | null = null;
        let interval: ReturnType<typeof setInterval> | null = null;

        try {
            audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();

            const playBeep = () => {
                if (!audioCtx || audioCtx.state === 'closed') return;
                if (audioCtx.state === 'suspended') {
                    audioCtx.resume().catch(() => {});
                }
                const oscillator = audioCtx.createOscillator();
                const gainNode = audioCtx.createGain();
                oscillator.type = 'square';
                oscillator.frequency.setValueAtTime(isAlarm ? 800 : 440, audioCtx.currentTime);
                gainNode.gain.setValueAtTime(isAlarm ? 0.12 : 0.05, audioCtx.currentTime);
                oscillator.connect(gainNode);
                gainNode.connect(audioCtx.destination);
                oscillator.start();
                oscillator.stop(audioCtx.currentTime + 0.2);
            };

            interval = setInterval(playBeep, isAlarm ? 500 : 1500);
            playBeep();
        } catch (e) {
            console.error('Audio API not supported or blocked', e);
        }

        if ('vibrate' in navigator) {
            const pattern = isAlarm ? [200, 100, 200, 100, 400] : [100];
            try { navigator.vibrate(pattern); } catch { }
            const vibInterval = setInterval(() => {
                try { navigator.vibrate(pattern); } catch { }
            }, isAlarm ? 1000 : 2000);
            return () => {
                clearInterval(vibInterval);
                if (interval) clearInterval(interval);
                if (audioCtx) audioCtx.close();
            };
        }

        return () => {
            if (interval) clearInterval(interval);
            if (audioCtx) audioCtx.close();
        };
    }, [isAlarm, isWarning]);

    if (!isAlarm && !isWarning) return null;

    const color = isAlarm ? 'var(--alarm)' : 'var(--warning)';
    const reasonText = safety.reason ? (REASON_LABELS[safety.reason] ?? safety.reason) : '';

    return (
        <div
            className="animate-fade-in"
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 9999,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 'var(--space-5)',
                padding: 'var(--space-6)',
                textAlign: 'center',
                /* Vercel-style: subtle tinted overlay, not harsh flash */
                background: isAlarm
                    ? 'radial-gradient(ellipse at center, rgba(239,68,68,0.35) 0%, rgba(9,9,11,0.92) 70%)'
                    : 'radial-gradient(ellipse at center, rgba(250,204,21,0.18) 0%, rgba(9,9,11,0.9) 70%)',
                backdropFilter: 'blur(var(--blur-lg))',
                WebkitBackdropFilter: 'blur(var(--blur-lg))',
            }}
        >
            {/* Pulsing icon container */}
            <div style={{
                width: 88,
                height: 88,
                borderRadius: '50%',
                background: isAlarm ? 'var(--alarm-dim)' : 'var(--warning-dim)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                animation: 'fade-in-scale 0.3s var(--ease-spring) both',
                boxShadow: `0 0 40px ${isAlarm ? 'var(--alarm-glow)' : 'var(--warning-glow)'}`,
            }}>
                <ShieldAlert size={40} color={color} />
            </div>

            {/* Title */}
            <div style={{ animation: 'fade-in 0.4s var(--ease-out) 0.1s both' }}>
                <h2 style={{
                    fontSize: 'clamp(1.5rem, 5vw, 2.2rem)',
                    fontWeight: 700,
                    letterSpacing: '-0.03em',
                    color: 'var(--text-primary)',
                    margin: 0,
                }}>
                    {isAlarm ? 'Perigo: Sonolência' : 'Atenção'}
                </h2>
            </div>

            {/* Reason */}
            {reasonText && (
                <p style={{
                    fontSize: 'var(--text-md)',
                    color: 'var(--text-secondary)',
                    maxWidth: 420,
                    lineHeight: 1.5,
                    margin: 0,
                    animation: 'fade-in 0.4s var(--ease-out) 0.2s both',
                }}>
                    {reasonText}
                </p>
            )}

            {/* Dismiss button — alarm only */}
            {isAlarm && (
                <button
                    className="btn btn-danger"
                    onClick={() => detectionEngine.ackAlarm()}
                    style={{
                        marginTop: 'var(--space-3)',
                        padding: 'var(--space-3) var(--space-8)',
                        fontSize: 'var(--text-md)',
                        fontWeight: 600,
                        animation: 'fade-in 0.4s var(--ease-out) 0.3s both',
                        background: 'var(--bg-card)',
                        borderColor: 'var(--alarm)',
                        color: 'var(--alarm)',
                    }}
                >
                    <ShieldCheck size={18} />
                    Estou acordado
                </button>
            )}
        </div>
    );
};
