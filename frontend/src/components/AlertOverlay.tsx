import React, { useEffect, useState } from 'react';
import { safetyEngine, type SafetySnapshot } from '../safety/safetyEngine';
import { detectionEngine } from '../detection/detectionEngine';
import { ShieldAlert } from 'lucide-react';

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
                if (!audioCtx) return;
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
    const reasonText = (() => {
        const map: Record<string, string> = {
            EYES_CLOSED_DURATION: 'Olhos fechados por tempo prolongado',
            PERCLOS_CRITICAL: 'Sonolência confirmada (PERCLOS crítico)',
            PERCLOS: 'Fechamentos de olho frequentes',
            YAWN: 'Bocejo detectado',
            HEAD_DROP: 'Cabeça abaixando',
            FACE_LOST: 'Rosto fora do enquadramento',
            PROLONGED_CLOSE: 'Olhos fechados acima do normal',
        };
        return safety.reason ? (map[safety.reason] ?? safety.reason) : '';
    })();

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: isAlarm ? 'rgba(239,68,68,0.5)' : 'rgba(250,204,21,0.25)',
                zIndex: 9999,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '1rem',
                animation: 'safenap-flash 0.6s infinite alternate',
                backdropFilter: 'blur(4px)',
                WebkitBackdropFilter: 'blur(4px)',
                padding: '1rem',
                textAlign: 'center',
            }}
        >
            <style>{`
                @keyframes safenap-flash {
                    from { opacity: 0.55; }
                    to { opacity: 0.95; }
                }
                @keyframes safenap-pulse {
                    from { transform: scale(1); }
                    to { transform: scale(1.08); }
                }
            `}</style>

            <div style={{ animation: 'safenap-pulse 0.5s infinite alternate' }}>
                <ShieldAlert size={72} color={color} />
            </div>

            <div style={{ fontSize: 'clamp(1.6rem, 6vw, 2.6rem)', fontWeight: 800, color: isAlarm ? '#fff' : '#1f2937', textShadow: '0 2px 12px rgba(0,0,0,0.5)' }}>
                {isAlarm ? 'PERIGO: SONOLÊNCIA!' : 'ATENÇÃO'}
            </div>

            {reasonText && (
                <div style={{ fontSize: 'clamp(0.95rem, 3vw, 1.2rem)', color: 'rgba(255,255,255,0.9)', textShadow: '0 1px 8px rgba(0,0,0,0.6)' }}>
                    {reasonText}
                </div>
            )}

            {isAlarm && (
                <button
                    className="btn"
                    onClick={() => detectionEngine.ackAlarm()}
                    style={{
                        marginTop: '1rem',
                        background: 'rgba(255,255,255,0.95)',
                        color: '#b91c1c',
                        fontWeight: 700,
                        fontSize: '1rem',
                        padding: '0.9rem 2rem',
                        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
                    }}
                >
                    Estou acordado — silenciar
                </button>
            )}
        </div>
    );
};
