# Latência de ida-e-volta do WebSocket (medida, backend real)

Backend real (uvicorn, processo separado, porta 8123), cliente websockets.connect() em loopback (127.0.0.1). Medido: DETECTOR_CLAIM enviado -> DETECTOR_ASSIGNED recebido (unico evento com resposta direta; SAFETY_EVENTS nao tem ACK por design). N=200 apos 10 de warmup. NAO inclui hardware fisico nem rede real de veiculo (Tailscale/Wi-Fi) -- e loopback local.

| N | média (ms) | mediana (ms) | p95 (ms) | p99 (ms) |
|---|---|---|---|---|
| 200 | 0.085 | 0.085 | 0.091 | 0.105 |
