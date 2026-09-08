export const EventType = {
    FACE_DETECTED: "FACE_DETECTED",
    FACE_LOST: "FACE_LOST",
    EYES_OPEN: "EYES_OPEN",
    EYES_CLOSED: "EYES_CLOSED",
    YAWN_DETECTED: "YAWN_DETECTED",
    HEAD_DROPPED: "HEAD_DROPPED",
    DROWSINESS_WARNING: "DROWSINESS_WARNING",
    DROWSINESS_WARNING_ENDED: "DROWSINESS_WARNING_ENDED",
    DROWSINESS_STARTED: "DROWSINESS_STARTED",
    DROWSINESS_ENDED: "DROWSINESS_ENDED",
    ALARM_ACKNOWLEDGED: "ALARM_ACKNOWLEDGED",
    HEARTBEAT: "HEARTBEAT",
    HARDWARE_STATUS: "HARDWARE_STATUS",
    GRIP_STATUS: "GRIP_STATUS",
    ERROR: "ERROR",
    // Sincronização multi-dispositivo (detector -> backend -> viewers)
    DETECTOR_CLAIM: "DETECTOR_CLAIM",
    DETECTOR_RELEASE: "DETECTOR_RELEASE",
    DETECTOR_ASSIGNED: "DETECTOR_ASSIGNED",
    DETECTOR_TAKEN: "DETECTOR_TAKEN",
    DETECTOR_CLEARED: "DETECTOR_CLEARED",
    METRICS_UPDATE: "METRICS_UPDATE",
    SESSION_SYNC: "SESSION_SYNC",
    CALIBRATION_SYNC: "CALIBRATION_SYNC",
    CALIBRATION_PROGRESS: "CALIBRATION_PROGRESS",
    CALIBRATION_REQUEST: "CALIBRATION_REQUEST",
    MODEL_SYNC: "MODEL_SYNC",
    STATE_SNAPSHOT: "STATE_SNAPSHOT"
} as const;

export type EventType = typeof EventType[keyof typeof EventType];

export interface WebSocketMessage {
    type: EventType;
    timestamp: number;
    session_id: string;
    payload?: any;
}

export type ConnectionStatus = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING" | "ERROR";

class WebSocketClient {
    private socket: WebSocket | null = null;
    private url: string;
    private sessionId: string;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 5;
    private listeners: Map<string, Array<(...args: any[]) => void>> = new Map();
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private intentionalClose: boolean = false;
    /** Callback opcional invocado ao (re)estabelecer a conexão — usado para
     * re-sincronizar o estado de segurança (ex: re-emitir ALARM após reconnect). */
    private onReconnectCallback: ((connected: boolean) => void) | null = null;
    public status: ConnectionStatus = "DISCONNECTED";

    constructor(url?: string) {
        if (url) {
            this.url = url;
        } else {
            const envWs = import.meta.env.VITE_WS_URL as string | undefined;
            if (envWs) {
                this.url = envWs;
            } else if (typeof window !== 'undefined') {
                const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsHost = window.location.host;
                this.url = `${wsProtocol}//${wsHost}/ws`;
            } else {
                this.url = 'ws://localhost/ws';
            }
        }
        // Token de autenticacao (quando o backend exige): anexado como query
        // param — headers customizados em WebSocket sao pouco portateis.
        const token = (import.meta.env.VITE_AUTH_TOKEN as string | undefined)?.trim();
        if (token && !this.url.includes('token=')) {
            this.url += (this.url.includes('?') ? '&' : '?') + `token=${encodeURIComponent(token)}`;
        }
        this.sessionId = Math.random().toString(36).substring(2, 15);
    }

    public getSessionId(): string {
        return this.sessionId;
    }

    /** Registra um callback invocado toda vez que a conexão (re)abre. */
    public onReconnect(callback: (connected: boolean) => void): void {
        this.onReconnectCallback = callback;
    }

    public connect() {
        if (this.status === "CONNECTED" || this.status === "CONNECTING") return;
        
        this.intentionalClose = false;
        this.status = "CONNECTING";
        this.notifyStatusChange();

        try {
            this.socket = new WebSocket(this.url);

            this.socket.onopen = () => {
                console.log("WebSocket connected");
                this.status = "CONNECTED";
                this.reconnectAttempts = 0;
                this.notifyStatusChange();
                // Re-sincroniza estado de segurança com o backend (ex: re-emitir ALARM)
                if (this.onReconnectCallback) {
                    this.onReconnectCallback(true);
                }
            };

            this.socket.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.triggerListener("message", data);
                    if (data.type) {
                        this.triggerListener(data.type, data.payload !== undefined ? data.payload : data);
                    }
                } catch (e) {
                    console.error("Error parsing WS message", e);
                }
            };

            this.socket.onclose = () => {
                console.log("WebSocket disconnected");
                this.status = "DISCONNECTED";
                this.notifyStatusChange();
                this.reconnect();
            };

            this.socket.onerror = (error) => {
                console.error("WebSocket error", error);
                this.status = "ERROR";
                this.notifyStatusChange();
            };
        } catch (e) {
            console.error("Falha ao criar WebSocket:", e);
            this.status = "ERROR";
            this.notifyStatusChange();
            this.reconnect();
        }
    }

    private reconnect() {
        if (this.intentionalClose) return;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error("Max reconnect attempts reached");
            return;
        }

        this.status = "RECONNECTING";
        this.notifyStatusChange();
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
        
        console.log(`Reconnecting in ${delay}ms...`);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    public disconnect() {
        this.intentionalClose = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.socket) {
            this.socket.close();
            this.socket = null;
            this.status = "DISCONNECTED";
            this.notifyStatusChange();
        }
    }

    public sendEvent(type: EventType, payload?: any) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            const msg: WebSocketMessage = {
                type,
                timestamp: Date.now() / 1000,
                session_id: this.sessionId,
                payload
            };
            this.socket.send(JSON.stringify(msg));
        } else {
            console.warn("WebSocket not connected. Cannot send message:", type);
        }
    }

    public onStatusChange(callback: (status: ConnectionStatus) => void) {
        this.addListener("status", callback);
    }

    public onMessage(callback: (msg: WebSocketMessage) => void) {
        this.addListener("message", callback);
    }

    public on(event: string, callback: (...args: any[]) => void) {
        this.addListener(event, callback);
    }

    public off(event: string, callback: (...args: any[]) => void) {
        const callbacks = this.listeners.get(event);
        if (callbacks) {
            this.listeners.set(event, callbacks.filter(cb => cb !== callback));
        }
    }

    private addListener(event: string, callback: (...args: any[]) => void) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event)?.push(callback);
    }

    private triggerListener(event: string, data: any) {
        const callbacks = this.listeners.get(event);
        if (callbacks) {
            callbacks.forEach(cb => cb(data));
        }
    }

    private notifyStatusChange() {
        this.triggerListener("status", this.status);
    }
}

export const wsClient = new WebSocketClient();
