"""Teste leve (sem pytest) para o fluxo de sincronização multi-dispositivo.

Valida: claim de detector, broadcast de métricas para viewers, snapshot inicial,
liberação do detector na desconexão e persistência de calibração/modelo.
"""
import asyncio
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Isola a persistência em arquivo temporário antes de importar o modulo.
TMP = tempfile.mktemp(suffix=".json")


class FakeWS:
    """WebSocket fake que guarda mensagens enviadas."""
    def __init__(self):
        self.sent = []
        self.accepted = False

    async def accept(self):
        self.accepted = True

    async def send_text(self, msg):
        self.sent.append(json.loads(msg))


def msg(type_, sid="s1", payload=None):
    return json.dumps({
        "type": type_,
        "timestamp": 1.0,
        "session_id": sid,
        "payload": payload or {},
    })


async def run():
    # Aponta o caminho de persistência para o temporário.
    import app.core.state_store as ss
    ss.DATA_PATH = TMP

    from app.core.state_store import state_store
    from app.websocket.manager import ConnectionManager

    cm = ConnectionManager()
    ws_detector = FakeWS()
    ws_viewer = FakeWS()

    await cm.connect(ws_detector)
    await cm.connect(ws_viewer)
    assert ws_detector.accepted and ws_viewer.accepted, "accept falhou"

    # Ambos devem ter recebido STATE_SNAPSHOT + (em main.py, HARDWARE_STATUS)
    assert any(m["type"] == "STATE_SNAPSHOT" for m in ws_detector.sent), "detector sem snapshot"
    assert any(m["type"] == "STATE_SNAPSHOT" for m in ws_viewer.sent), "viewer sem snapshot"

    # Detetor reivindica o papel.
    await cm.handle_message(msg("DETECTOR_CLAIM", "det1"), ws_detector)
    assert any(m["type"] == "DETECTOR_ASSIGNED" for m in ws_detector.sent), "detector sem ack"
    assert any(m["type"] == "DETECTOR_TAKEN" for m in ws_viewer.sent), "viewer sem aviso TAKEN"

    # Segundo device tenta reivindicar — deve ser negado.
    ws_second = FakeWS()
    await cm.connect(ws_second)
    await cm.handle_message(msg("DETECTOR_CLAIM", "det2"), ws_second)
    assert any(m["type"] == "DETECTOR_TAKEN" for m in ws_second.sent), "segundo claim aceito indevidamente"

    # Detetor publica métricas — viewer deve receber, detetor não (eco).
    metrics_payload = {
        "state": "NORMAL", "reason": None, "facePresent": True, "ear": 0.3,
        "perclose": 0.1, "eyesClosed": False, "threshold": 0.25, "mlScore": None,
    }
    n_before = len(ws_viewer.sent)
    n_det_before = len(ws_detector.sent)
    await cm.handle_message(msg("METRICS_UPDATE", "det1", metrics_payload), ws_detector)
    assert any(
        m["type"] == "METRICS_UPDATE" and m["payload"]["ear"] == 0.3
        for m in ws_viewer.sent[n_before:]
    ), "viewer nao recebeu METRICS_UPDATE"
    assert not any(
        m["type"] == "METRICS_UPDATE" for m in ws_detector.sent[n_det_before:]
    ), "detector recebeu eco da propria mensagem"

    # Calibração compartilhada é persistida e encaminhada.
    cal_payload = {"baselineEar": 0.3, "threshold": 0.24, "calibratedAt": 123}
    await cm.handle_message(msg("CALIBRATION_SYNC", "det1", cal_payload), ws_detector)
    assert any(m["type"] == "CALIBRATION_SYNC" for m in ws_viewer.sent), "viewer sem CALIBRATION_SYNC"
    assert state_store.data["calibration"] == cal_payload, "calibração não armazenada"

    await asyncio.sleep(0.7)  # debounce de persistência (0.5s)
    if os.path.exists(TMP):
        with open(TMP, "r", encoding="utf-8") as f:
            persisted = json.load(f)
        assert persisted["calibration"] == cal_payload, "persistência da calibração falhou"
    else:
        raise AssertionError("arquivo de persistencia nao criado")

    # Snapshot de um novo viewer inclui o estado ao vivo.
    ws_new = FakeWS()
    await cm.connect(ws_new)
    snap = next(m for m in ws_new.sent if m["type"] == "STATE_SNAPSHOT")
    assert snap["payload"]["has_detector"] is True, "snapshot sem detector"
    assert snap["payload"]["metrics"]["ear"] == 0.3, "snapshot sem metricas"
    assert snap["payload"]["calibration"]["threshold"] == 0.24, "snapshot sem calibracao"

    # Detector desconecta: papel é liberado e viewers avisados.
    await cm.disconnect_async(ws_detector)
    assert state_store.get_detector() is None, "detector nao foi liberado"
    assert any(m["type"] == "DETECTOR_CLEARED" for m in ws_viewer.sent), "viewers sem DETECTOR_CLEARED"

    # Agora o segundo device pode reivindicar.
    await cm.handle_message(msg("DETECTOR_CLAIM", "det2"), ws_second)
    assert any(m["type"] == "DETECTOR_ASSIGNED" for m in ws_second.sent), "det2 nao assumiu apos liberacao"

    print("TODOS OS TESTES BACKEND PASSARAM")
    try:
        os.remove(TMP)
    except OSError:
        pass


if __name__ == "__main__":
    asyncio.run(run())
