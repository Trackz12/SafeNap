"""Armazenamento compartilhado de estado do SafeNap.

Persistência (arquivo JSON local) para os dados que precisam ser iguais em
todos os dispositivos: calibração bifásica e modelo ML do usuário.
Em memória: qual sessão é o "detector" ativo (device que roda a câmera).

Regra de arquitetura: o backend NUNCA recebe frames de vídeo — apenas métricas
derivadas e modelos serializados.
"""

import json
import logging
import os
import threading
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

DATA_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "safenap_shared.json",
)

_SAVE_LOCK = threading.Lock()
# Payloads de modelo podem ser grandes; debounce evita escrita a cada frame.
_save_debounce: Dict[str, Optional[threading.Timer]] = {"timer": None}
_SAVE_DEBOUNCE_S = 0.5


class StateStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.data: Dict[str, Any] = {
            "calibration": None,
            "user_model": None,
            "metrics": None,
            "session": None,
        }
        self.detector_session: Optional[str] = None
        self._load()

    # ---------- persistência ----------

    def _load(self) -> None:
        try:
            if os.path.exists(DATA_PATH):
                with open(DATA_PATH, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                for key in ("calibration", "user_model"):
                    self.data[key] = loaded.get(key)
                logger.info("Estado compartilhado carregado de %s", DATA_PATH)
        except Exception as e:
            logger.warning("Falha ao carregar estado compartilhado: %s", e)

    def _persist_now(self) -> None:
        with _SAVE_LOCK:
            try:
                tmp = DATA_PATH + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(
                        {
                            "calibration": self.data.get("calibration"),
                            "user_model": self.data.get("user_model"),
                        },
                        f,
                        ensure_ascii=False,
                    )
                os.replace(tmp, DATA_PATH)
            except Exception as e:
                logger.warning("Falha ao persistir estado compartilhado: %s", e)

    def _persist_debounced(self) -> None:
        timer = _save_debounce["timer"]
        if timer is not None:
            timer.cancel()
        t = threading.Timer(_SAVE_DEBOUNCE_S, self._persist_now)
        t.daemon = True
        _save_debounce["timer"] = t
        t.start()

    # ---------- detector role ----------

    def claim_detector(self, session_id: str) -> bool:
        """Primeiro claim vence. Retorna True se aceito."""
        with self._lock:
            if self.detector_session is None or self.detector_session == session_id:
                self.detector_session = session_id
                return True
            logger.info(
                "DETECTOR_CLAIM de %s negado (detector atual: %s)",
                session_id,
                self.detector_session,
            )
            return False

    def release_detector(self, session_id: str) -> bool:
        """Libera o papel se for o dono. Retorna True se liberou."""
        with self._lock:
            if self.detector_session == session_id:
                self.detector_session = None
                return True
            return False

    def get_detector(self) -> Optional[str]:
        with self._lock:
            return self.detector_session

    # ---------- dados compartilhados ----------

    def update(self, kind: str, payload: Optional[Dict[str, Any]]) -> None:
        """Guarda um bloco (metrics/session) e/ou persiste (calibration/user_model)."""
        with self._lock:
            self.data[kind] = payload
            if kind in ("calibration", "user_model"):
                self._persist_debounced()

    def snapshot(self) -> Dict[str, Any]:
        """Estado atual completo para enviar a um viewer recém-conectado."""
        with self._lock:
            return {
                "has_detector": self.detector_session is not None,
                "detector": self.detector_session,
                "calibration": self.data.get("calibration"),
                "user_model": self.data.get("user_model"),
                "metrics": self.data.get("metrics"),
                "session": self.data.get("session"),
            }

    def clear_live(self) -> None:
        """Limpa dados de sessão ao vivo (detector desconectou / sem dados)."""
        with self._lock:
            self.data["metrics"] = None
            self.data["session"] = None


state_store = StateStore()
