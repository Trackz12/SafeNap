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
    MICROSLEEP: 'Micro-sono detectado — reaja!',
    EAR_TREND: 'Sinais crescentes de fadiga (pálpebras pesando)',
    SLOW_BLINKS: 'Piscadas lentas — sinais de fadiga',
    ML_WARNING: 'Modelo ML: alto risco de fadiga',
    ML_ALARM: 'Modelo ML: sonolência confirmada',
};

export const AlertOverlay: React.FC = () => {
    const [safety, setSafety] = useState<SafetySnapshot>({ state: 'NORMAL', reason: null });

    useEffect(() => {
        const unsub = safetyEngine.onStateChange((snapshot) => setSafety(snapshot));
        return unsub;
    }, []);

    const isAlarm = safety.state === 'ALARM';
    const isWarning = safety.state === 'WARNING';

    // WARNING: beep único ao entrar no estado (sem loop) — o overlay de
    // atenção não pode competir com o alarme real em intrusividade.
    // ALARM: loop de beep/vibração enquanto durar (é o estado de perigo).
    useEffect(() => {
        if (!isAlarm && !isWarning) return;

        let audioCtx: AudioContext | null = null;
        let interval: ReturnType<typeof setInterval> | null = null;
        let vibInterval: ReturnType<typeof setInterval> | null = null;

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

        try {
            audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
            playBeep();
            if (isAlarm) {
                interval = setInterval(playBeep, 500);
            }
        } catch (e) {
            console.error('Audio API not supported or blocked', e);
        }

        if ('vibrate' in navigator) {
            const pattern = isAlarm ? [200, 100, 200, 100, 400] : [100];
            try { navigator.vibrate(pattern); } catch { }
            if (isAlarm) {
                vibInterval = setInterval(() => {
                    try { navigator.vibrate(pattern); } catch { }
                }, 1000);
            }
        }

        return () => {
            if (interval) clearInterval(interval);
            if (vibInterval) clearInterval(vibInterval);
            if (audioCtx) audioCtx.close();
        };
    }, [isAlarm, isWarning]);

    if (!isAlarm && !isWarning) return null;

    const color = isAlarm ? 'var(--alarm)' : 'var(--warning)';
    const reasonText = safety.reason ? (REASON_LABELS[safety.reason] ?? safety.reason) : '';

    // WARNING: banner compacto no topo — não bloqueia a interface, sem
    // blur, sem cobrir a tela. O alerta de "atenção" é informativo; só
    // o ALARM (perigo concreto) justifica interromper o usuário.
    // Nota: o estado pode ser WARNING durante a saída de um ALARM
    // (release gradual) — nesse caso mostra o banner, não o fullscreen.
    if (!isAlarm) {
        return (
            <div
                role="status"
                aria-live="polite"
                className="animate-slide-down"
                style={{
                    position: 'fixed',
                    top: 'var(--space-4)',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    zIndex: 9990,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-3) var(--space-5)',
                    borderRadius: 'var(--radius-lg)',
                    background: 'var(--bg-card)',
                    border: '1px solid var(--warning)',
                    boxShadow: '0 4px 24px var(--warning-glow)',
                    maxWidth: 'min(92vw, 480px)',
                }}
            >
                <span
                    style={{
                        width: 34,
                        height: 34,
                        borderRadius: '50%',
                        background: 'var(--warning-dim)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                    }}
                >
                    <ShieldAlert size={18} color={color} />
                </span>
                <div style={{ textAlign: 'left', minWidth: 0 }}>
                    <strong style={{
                        display: 'block',
                        fontSize: 'var(--text-sm)',
                        fontWeight: 600,
                        color: 'var(--warning)',
                        letterSpacing: '-0.01em',
                    }}>
                        Atenção
                    </strong>
                    <span style={{
                        display: 'block',
                        fontSize: 'var(--text-xs)',
                        color: 'var(--text-secondary)',
                        lineHeight: 1.4,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}>
                        {reasonText || 'Sinais de fadiga detectados'}
                    </span>
                </div>
            </div>
        );
    }

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
                background: 'radial-gradient(ellipse at center, rgba(239,68,68,0.35) 0%, rgba(9,9,11,0.92) 70%)',
                backdropFilter: 'blur(var(--blur-lg))',
                WebkitBackdropFilter: 'blur(var(--blur-lg))',
            }}
        >
            {/* Pulsing icon container */}
            <div style={{
                width: 88,
                height: 88,
                borderRadius: '50%',
                background: 'var(--alarm-dim)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                animation: 'fade-in-scale 0.3s var(--ease-spring) both',
                boxShadow: `0 0 40px var(--alarm-glow)`,
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
                    Perigo: Sonolência
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
        </div>
    );
};
