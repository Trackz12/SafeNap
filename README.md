# SafeNap

Sistema de detecção de sonolência ao volante. A câmera é processada no próprio navegador com visão computacional (MediaPipe), sem enviar vídeo a nenhum servidor, e quando há sinais de sono um backend em FastAPI aciona um Arduino que alerta o motorista com som, vibração e luz.

Projeto de TCC do curso Técnico em Automação Industrial do IFSP, campus Sertãozinho, apresentado em artigos no CONICT 2025 e 2026 (`docs/artigo/`).

## O que ele faz

- Detecta em tempo real sinais de sonolência pelo rosto do motorista, direto no navegador.
- Envia o estado ao backend por WebSocket; o backend fala com o Arduino pela porta serial (PySerial).
- No Arduino Nano: buzzer, 4 motores de vibração, LED e um sensor de pressão (FSR-402) na empunhadura do volante.
- Pipeline de Machine Learning em Python (extração de características, treino, avaliação e exportação para ONNX), ainda experimental.

## Tecnologias

React, TypeScript e Vite · MediaPipe Tasks Vision · Python, FastAPI e PySerial · Arduino (C++) · Vitest e pytest

Testes automatizados: 219 no frontend e 96 no pipeline de ML.

## Documentação

- [Arquitetura](docs/ARCHITECTURE.md)
- [Detecção](docs/DETECTION.md)
- [Protocolo do WebSocket](docs/WEBSOCKET_PROTOCOL.md)
- [Hardware](docs/HARDWARE.md)
- [Pipeline de ML](docs/ML_PIPELINE.md) e [datasets](docs/DATASET_PIPELINE.md)

## Autor

Lucas Cândido · [site](https://lucas-candido.vercel.app) · [LinkedIn](https://www.linkedin.com/in/lucas-candido-martins-0096552b7)

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
