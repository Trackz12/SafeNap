# SAFENAP Web

Sistema moderno de detecção de sonolência no navegador utilizando MediaPipe. A aplicação aciona um Arduino Nano através de um backend FastAPI via WebSocket e PySerial.

## Estrutura
- **Frontend**: React + Vite + TypeScript (Processamento da câmera e visão).
- **Backend**: FastAPI + Python (Comunicação Serial).
- **Arduino**: Código C++ para o Arduino Nano (Buzzer, 4 motores de vibração, LED, leitura de 1 sensor FSR-402 na empunhadura do volante).

## Requisitos
- Node.js (18+)
- Python (3.10+)
- Arduino IDE (para enviar o firmware)

## Execução

### Frontend
```bash
cd frontend
npm install
npm run dev
```

### Backend
```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # ou .venv\Scripts\activate no Windows
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## Acesso pelo celular

A câmera exige um **Secure Context** (HTTPS com certificado válido) em dispositivos móveis. Os navegadores podem silenciosamente se recusar a renderizar o fluxo de vídeo (tela preta) quando o certificado não é confiável.

1. No celular, acesse `https://IP_DO_SEU_PC:5173`.
2. O dev server usa um certificado autoassinado (`@vitejs/plugin-basic-ssl`). **Você deve aceitar o aviso do navegador e prosseguir ANTES de tocar em "Iniciar Câmera"** — se a página for aceita apenas depois, o vídeo pode não renderizar (tela preta).
3. O backend FastAPI (porta 8000) é acessado automaticamente pelo Vite proxy (`/api` e `/ws`) na mesma porta HTTPS — o celular **não** precisa de acesso direto à porta 8000.

Se a tela preta persistir após aceitar o certificado, recarregue a página uma vez antes de tentar novamente.
