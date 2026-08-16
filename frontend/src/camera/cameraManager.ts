function waitForMetadata(videoElement: HTMLVideoElement, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve) => {
        if (videoElement.readyState >= 3 && videoElement.videoWidth > 0) {
            resolve();
            return;
        }
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        };
        const cleanup = () => {
            videoElement.removeEventListener('loadeddata', done);
            videoElement.removeEventListener('loadedmetadata', done);
            clearTimeout(timer);
        };
        const timer = setTimeout(done, timeoutMs);
        videoElement.addEventListener('loadeddata', done, { once: true });
        videoElement.addEventListener('loadedmetadata', done, { once: true });
    });
}

export class CameraManager {
    private stream: MediaStream | null = null;
    private videoElement: HTMLVideoElement | null = null;

    /**
     * Procura o ID da câmera frontal enumerando os dispositivos de mídia.
     */
    private async getFrontCameraDeviceId(): Promise<string | null> {
        try {
            if (!navigator.mediaDevices?.enumerateDevices) return null;
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(d => d.kind === 'videoinput');
            
            // Busca por rótulo indicativo de câmera frontal
            const frontDevice = videoDevices.find(d => 
                d.label.toLowerCase().includes('front') || 
                d.label.toLowerCase().includes('user') ||
                d.label.toLowerCase().includes('frontal') ||
                d.label.toLowerCase().includes('facing front')
            );

            return frontDevice ? frontDevice.deviceId : null;
        } catch {
            return null;
        }
    }

    /**
     * Cascata de Aquisição em 3 Níveis para Celulares e Desktops
     */
    private async acquireStreamCascade(): Promise<MediaStream> {
        // Nível 1: Tenta abrir pelo Device ID exato da câmera frontal
        const frontDeviceId = await this.getFrontCameraDeviceId();
        if (frontDeviceId) {
            try {
                console.log(`[CameraManager] Tentando Nível 1 (Device ID Frontal: ${frontDeviceId})...`);
                return await navigator.mediaDevices.getUserMedia({
                    video: {
                        deviceId: { exact: frontDeviceId },
                        width: { ideal: 640 },
                        height: { ideal: 480 }
                    },
                    audio: false
                });
            } catch (e) {
                console.warn("[CameraManager] Nível 1 falhou, tentando Nível 2...", e);
            }
        }

        // Nível 2: Tenta usando facingMode: 'user' com resoluções ideais
        try {
            console.log("[CameraManager] Tentando Nível 2 (FacingMode: user)...");
            return await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'user',
                    width: { ideal: 640 },
                    height: { ideal: 480 }
                },
                audio: false
            });
        } catch (e) {
            console.warn("[CameraManager] Nível 2 falhou, tentando Nível 3 (Fallback Universal)...", e);
        }

        // Nível 3: Fallback Universal sem restrições
        console.log("[CameraManager] Tentando Nível 3 (video: true)...");
        return await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false
        });
    }

    public async startCamera(videoElement: HTMLVideoElement): Promise<void> {
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error(
                    "O navegador do celular bloqueou a câmera. No celular, o acesso à câmera exige HTTPS (ou localhost). Se você está acessando via IP, utilize HTTPS."
                );
            }

            // Libera qualquer hardware anteriormente preso
            this.stopCamera();
            await new Promise((r) => setTimeout(r, 200));

            // Obtém o stream através da cascata de resiliência
            this.stream = await this.acquireStreamCascade();
            this.videoElement = videoElement;

            videoElement.muted = true;
            videoElement.autoplay = true;
            videoElement.setAttribute('playsinline', 'true');
            videoElement.setAttribute('webkit-playsinline', 'true');

            videoElement.srcObject = this.stream;

            await waitForMetadata(videoElement);

            try {
                await videoElement.play();
            } catch (err) {
                console.warn("[CameraManager] Primeiro play() falhou, tentando novamente...", err);
                await new Promise((r) => setTimeout(r, 300));
                await videoElement.play();
            }
        } catch (error: any) {
            this.stopCamera();
            console.error("Erro ao acessar a câmera:", error);
            if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
                throw new Error("A câmera do celular estava temporariamente ocupada. Por favor, tente clicar novamente em Iniciar Câmera.");
            } else if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError' || error.name === 'SecurityError') {
                throw new Error("O acesso à câmera foi negado ou bloqueado pelo navegador. Verifique se você está em HTTPS e permita o acesso à câmera nas configurações do site.");
            } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                throw new Error("Nenhuma câmera frontal foi encontrada no dispositivo.");
            } else if (error.name === 'OverconstrainedError') {
                throw new Error("A resolução solicitada não é suportada por esta câmera.");
            }
            throw error;
        }
    }

    public stopCamera(): void {
        if (this.stream) {
            this.stream.getTracks().forEach(track => {
                try {
                    track.enabled = false;
                    track.stop();
                } catch {}
            });
            this.stream = null;
        }
        if (this.videoElement) {
            try {
                this.videoElement.pause();
                this.videoElement.srcObject = null;
            } catch {}
        }
    }

    public isCameraActive(): boolean {
        return this.stream !== null && this.stream.active;
    }

    public getStream(): MediaStream | null {
        return this.stream;
    }
}

export const cameraManager = new CameraManager();
