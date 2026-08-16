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
        """Interrompe a sondagem ate o proximo connect() explicito."""
        if self._auto_connect_enabled:
            logger.info("Sondagem automatica da porta serial desativada.")
        self._auto_connect_enabled = False

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

                # Inicia a thread de leitura
                self._read_thread = threading.Thread(target=self._read_loop, daemon=True)
                self._read_thread.start()

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
        # AQUI processamos respostas do Arduino, como "OK:ALARM_ON"
        pass

    def _trigger_status_change(self):
        if self.on_status_change_callback:
            try:
                self.on_status_change_callback(self.connected)
            except Exception as e:
                logger.error(f"Erro no callback de status serial: {e}")

serial_manager = SerialManager()
