import serial
import serial.tools.list_ports
import threading
import time
import logging

logger = logging.getLogger(__name__)

class SerialManager:
    # Intervalo da sondagem automatica: tenta conectar sempre que estiver
    # desconectado (Arduino plugado apos o boot, queda de conexao, etc.)
    AUTO_CONNECT_INTERVAL_S = 5.0

    # Health check: ping STATUS a cada PING_INTERVAL_S enquanto conectado.
    # Se o Arduino nao responder por UNRESPONSIVE_AFTER_S, e marcado
    # unresponsive (conectado fisicamente mas travado/sem firmware).
    PING_INTERVAL_S = 10.0
    UNRESPONSIVE_AFTER_S = 35.0

    def __init__(self, baudrate: int = 9600):
        self.baudrate = baudrate
        self.serial_conn = None
        self.connected = False
        self._lock = threading.Lock()
        self._running = False
        self._read_thread = None
        self._auto_connect_enabled = False
        self._auto_connect_thread = None
        self.on_status_change_callback = None
        # --- health check ---
        self._ping_thread = None
        self._last_response_at: float | None = None

    def autodetect_port(self) -> str | None:
        """Tenta encontrar uma porta serial disponível que possa ser o Arduino."""
        ports = serial.tools.list_ports.comports()
        for port in ports:
            # Em muitos casos o Arduino tem "CH340" ou "Arduino" ou "Serial" na descricao
            if "Arduino" in port.description or "CH340" in port.description or "Serial" in port.description:
                return port.device
        # Se nao encontrou pela descricao, retorna a primeira disponivel se houver
        if ports:
            return ports[0].device
        return None

    def start_auto_connect(self):
        """Ativa a sondagem automatica em background.

        Cobre tanto o caso de o Arduino nao estar plugado na inicializacao
        quanto quedas inesperadas de conexao: a cada intervalo, se nao houver
        conexao ativa, tenta detectar e conectar.
        """
        if self._auto_connect_thread is not None and self._auto_connect_thread.is_alive():
            self._auto_connect_enabled = True
            return
        self._auto_connect_enabled = True
        self._auto_connect_thread = threading.Thread(
            target=self._auto_connect_loop, daemon=True, name="serial-auto-connect"
        )
        self._auto_connect_thread.start()
        logger.info("Sondagem automatica da porta serial habilitada.")

    def stop_auto_connect(self):
        """Interrompe a sondagem e garante que a thread terminou (sinaliza + join)."""
        if self._auto_connect_enabled:
            logger.info("Sondagem automatica da porta serial desativada.")
        self._auto_connect_enabled = False
        thread = self._auto_connect_thread
        if thread is not None:
            thread.join(timeout=6.0)
            self._auto_connect_thread = None

    def _auto_connect_loop(self):
        while self._auto_connect_enabled:
            if not self.connected:
                try:
                    port = self.autodetect_port()
                    if port:
                        logger.info(f"Sondagem automatica: porta {port} disponivel; conectando...")
                        self.connect(port)
                except Exception as e:
                    logger.error(f"Erro na sondagem automatica: {e}")
            time.sleep(self.AUTO_CONNECT_INTERVAL_S)

    def connect(self, port: str = None) -> bool:
        # Conexao explicita tambem reativa a sondagem: se a conexao cair
        # depois, a reconexao automatica volta a agir.
        self._auto_connect_enabled = True

        with self._lock:
            if self.connected:
                return True

            target_port = port or self.autodetect_port()
            if not target_port:
                logger.debug("Nenhuma porta serial encontrada.")
                self._trigger_status_change()
                return False

            try:
                self.serial_conn = serial.Serial(target_port, self.baudrate, timeout=1)
                self.connected = True
                self._running = True
                logger.info(f"Conectado à porta serial: {target_port}")

                # Inicia a thread de leitura apenas se a anterior ja terminou,
                # evitando duas threads lendo do mesmo porta (race/redundancia).
                if self._read_thread is None or not self._read_thread.is_alive():
                    self._read_thread = threading.Thread(target=self._read_loop, daemon=True)
                    self._read_thread.start()
                else:
                    logger.warning("Thread de leitura anterior ainda ativa; reutilizada.")

                # Health check: pinger periodico + reset do tracker de respostas.
                self._last_response_at = time.time()
                self._start_ping_thread()

                self._trigger_status_change()
                return True
            except Exception as e:
                logger.error(f"Erro ao conectar na porta {target_port}: {e}")
                self.serial_conn = None
                self.connected = False
                self._trigger_status_change()
                return False

    def disconnect(self):
        """Desconexao explicita (UI/API): tambem desativa a sondagem automatica."""
        self.stop_auto_connect()
        self._teardown()
        logger.info("Desconectado da porta serial.")

    def _teardown(self):
        with self._lock:
            self._running = False
            self.connected = False
            if self.serial_conn and self.serial_conn.is_open:
                try:
                    self.serial_conn.close()
                except Exception as e:
                    logger.error(f"Erro ao desconectar: {e}")
            self.serial_conn = None
        self._stop_ping_thread()
        # Une a thread de leitura para garantir que ela terminou antes de
        # uma futura reconexao (evita duas threads lendo no mesmo porta).
        read_thread = self._read_thread
        self._read_thread = None
        if read_thread is not None and read_thread.is_alive() and read_thread is not threading.current_thread():
            try:
                read_thread.join(timeout=2.0)
            except Exception:
                pass
        self._trigger_status_change()

    def send_command(self, command: str) -> bool:
        if not self.connected or not self.serial_conn:
            logger.warning("Tentativa de enviar comando sem conexão serial.")
            return False

        try:
            with self._lock:
                full_cmd = f"{command}\n".encode('utf-8')
                self.serial_conn.write(full_cmd)
                logger.debug(f"Comando enviado: {command}")
            return True
        except Exception as e:
            logger.error(f"Erro ao enviar comando {command}: {e}")
            self._handle_disconnect()
            return False

    def _read_loop(self):
        while self._running:
            try:
                if self.serial_conn and self.serial_conn.in_waiting > 0:
                    line = self.serial_conn.readline().decode('utf-8').strip()
                    if line:
                        logger.info(f"Arduino disse: {line}")
                        self._handle_response(line)
                else:
                    time.sleep(0.05)
            except Exception as e:
                logger.error(f"Erro na leitura serial: {e}")
                if self._running:
                    self._handle_disconnect()
                break

    def _handle_disconnect(self):
        """Queda inesperada: derruba a conexao atual sem desativar a sondagem,
        que seguira tentando reconectar (agora cobre todos os cenarios)."""
        self._teardown()

    def _handle_response(self, response: str):
        """Qualquer resposta valida do Arduino renova o health check."""
        if response.startswith(("OK:", "SAFENAP_READY")):
            self._last_response_at = time.time()
            if response == "OK:STATUS_ONLINE":
                logger.debug("Health check: Arduino respondeu ao ping.")
        elif response.startswith("ERR:"):
            logger.warning(f"Arduino reportou erro: {response}")

    # ---------- health check ----------

    def _start_ping_thread(self):
        if self._ping_thread is not None and self._ping_thread.is_alive():
            return
        self._ping_thread = threading.Thread(
            target=self._ping_loop, daemon=True, name="serial-health-ping"
        )
        self._ping_thread.start()

    def _stop_ping_thread(self):
        thread = self._ping_thread
        self._ping_thread = None
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            try:
                thread.join(timeout=2.0)
            except Exception:
                pass

    def _ping_loop(self):
        """Envia STATUS periodicamente enquanto conectado; detecta Arduino
        travado (conectado mas sem responder) e derruba para reconexao."""
        while self._running and self.connected:
            time.sleep(self.PING_INTERVAL_S)
            if not self._running or not self.connected:
                break
            # Sem resposta por tempo demais: hardware travado — reconecta.
            if self._last_response_at is not None:
                silent_for = time.time() - self._last_response_at
                if silent_for > self.UNRESPONSIVE_AFTER_S:
                    logger.warning(
                        f"Arduino sem resposta há {silent_for:.0f}s (travado?): reconectando."
                    )
                    self._handle_disconnect()
                    break
            self.send_command("STATUS")

    def is_responsive(self) -> bool:
        """Arduino conectado E respondendo aos pings de saúde."""
        if not self.connected or self._last_response_at is None:
            return False
        return (time.time() - self._last_response_at) <= self.UNRESPONSIVE_AFTER_S

    def last_response_age_s(self) -> float | None:
        """Segundos desde a última resposta; None se nunca respondeu."""
        if self._last_response_at is None:
            return None
        return time.time() - self._last_response_at

    def _trigger_status_change(self):
        if self.on_status_change_callback:
            try:
                self.on_status_change_callback(self.connected)
            except Exception as e:
                logger.error(f"Erro no callback de status serial: {e}")

serial_manager = SerialManager()
