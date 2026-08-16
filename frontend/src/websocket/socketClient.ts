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
    ERROR: "ERROR"
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
    private listeners: Map<string, Function[]> = new Map();
    public status: ConnectionStatus = "DISCONNECTED";

    constructor(url?: string) {
        if (url) {
            this.url = url;
        } else {
            const envWs = import.meta.env.VITE_WS_URL as string | undefined;
            if (envWs) {
                this.url = envWs;
            } else {
                const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsHost = window.location.host;
                this.url = `${wsProtocol}//${wsHost}/ws`;
            }
        }
        this.sessionId = Math.random().toString(36).substring(2, 15);
    }

    public connect() {
        if (this.status === "CONNECTED" || this.status === "CONNECTING") return;
        
        this.status = "CONNECTING";
        this.notifyStatusChange();

        try {
            this.socket = new WebSocket(this.url);

            this.socket.onopen = () => {
                console.log("WebSocket connected");
                this.status = "CONNECTED";
                this.reconnectAttempts = 0;
                this.notifyStatusChange();
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
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error("Max reconnect attempts reached");
            return;
        }

        this.status = "RECONNECTING";
        this.notifyStatusChange();
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
        
        console.log(`Reconnecting in ${delay}ms...`);
        setTimeout(() => {
            this.connect();
        }, delay);
    }

    public disconnect() {
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

    public on(event: string, callback: Function) {
        this.addListener(event, callback);
    }

    public off(event: string, callback: Function) {
        const callbacks = this.listeners.get(event);
        if (callbacks) {
            this.listeners.set(event, callbacks.filter(cb => cb !== callback));
        }
    }

    private addListener(event: string, callback: Function) {
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
