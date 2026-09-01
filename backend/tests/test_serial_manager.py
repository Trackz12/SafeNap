"""Testes do SerialManager — conexão, threads de leitura e reconexão.

O pyserial é mockado para simular o Arduino sem hardware real.
Cobre: connect/disconnect, guarda contra threads duplicadas (race), auto-connect.
"""
from unittest.mock import patch, MagicMock
from app.serial.manager import SerialManager


def make_serial_mock() -> MagicMock:
    """Serial fake com atributos usados pelo _read_loop configurados.

    `in_waiting = 0` faz a thread de leitura dormir (time.sleep) em vez de
    quebrar comparando MagicMock > int (o que derrubaria a conexão).
    `write` retorna o número de bytes (int) como pyserial real.
    """
    m = MagicMock()
    m.in_waiting = 0
    m.is_open = True
    m.write.return_value = len(b"ALARM_ON\n")
    return m


def teardown(manager: SerialManager):
    """Garante threads paradas ao fim de cada teste (evita vazamento entre testes)."""
    manager.stop_auto_connect()
    manager._teardown()


class TestSerialManagerConnect:
    def test_connect_without_port_returns_false(self):
        manager = SerialManager()
        with patch.object(manager, "autodetect_port", return_value=None):
            assert manager.connect() is False
            assert manager.connected is False

    def test_connect_with_port_succeeds(self):
        manager = SerialManager()
        with patch("app.serial.manager.serial.Serial", return_value=make_serial_mock()):
            result = manager.connect("COM3")
        try:
            assert result is True
            assert manager.connected is True
            assert manager._running is True
        finally:
            teardown(manager)

    def test_connect_failure_returns_false(self):
        manager = SerialManager()
        with patch("app.serial.manager.serial.Serial", side_effect=Exception("port busy")):
            result = manager.connect("COM3")
        try:
            assert result is False
            assert manager.connected is False
            assert manager.serial_conn is None
        finally:
            teardown(manager)

    def test_connect_when_already_connected_returns_true(self):
        manager = SerialManager()
        manager.connected = True
        try:
            with patch("app.serial.manager.serial.Serial") as mock_serial_class:
                # Não deve nem tentar abrir de novo
                result = manager.connect("COM3")
            assert result is True
            mock_serial_class.assert_not_called()
        finally:
            manager.connected = False
            teardown(manager)


class TestSerialManagerDisconnect:
    def test_disconnect_stops_everything(self):
        manager = SerialManager()
        mock_serial = make_serial_mock()
        with patch("app.serial.manager.serial.Serial", return_value=mock_serial):
            manager.connect("COM3")
        manager.disconnect()
        assert manager.connected is False
        assert manager._running is False
        mock_serial.close.assert_called_once()

    def test_disconnect_disables_auto_connect(self):
        manager = SerialManager()
        manager._auto_connect_enabled = True
        manager.disconnect()
        assert manager._auto_connect_enabled is False


class TestSendCommand:
    def test_send_command_when_connected(self):
        manager = SerialManager()
        mock_serial = make_serial_mock()
        with patch("app.serial.manager.serial.Serial", return_value=mock_serial):
            manager.connect("COM3")
        try:
            result = manager.send_command("ALARM_ON")
            assert result is True
            mock_serial.write.assert_called_once_with(b"ALARM_ON\n")
        finally:
            teardown(manager)

    def test_send_command_when_disconnected_fails(self):
        manager = SerialManager()
        result = manager.send_command("ALARM_ON")
        assert result is False

    def test_send_command_write_error_triggers_disconnect(self):
        manager = SerialManager()
        mock_serial = make_serial_mock()
        mock_serial.write.side_effect = Exception("port lost")
        with patch("app.serial.manager.serial.Serial", return_value=mock_serial):
            manager.connect("COM3")
        try:
            result = manager.send_command("ALARM_ON")
            assert result is False
            assert manager.connected is False
        finally:
            teardown(manager)


class TestAutoConnect:
    def test_start_auto_connect_spawns_thread(self):
        manager = SerialManager()
        # Isola do ambiente: sem portas reais (CI tem /dev/ttyS*) e sem conectar.
        with patch.object(manager, "autodetect_port", return_value=None):
            manager.start_auto_connect()
            try:
                assert manager._auto_connect_thread is not None
                assert manager._auto_connect_thread.is_alive()
            finally:
                manager.stop_auto_connect()

    def test_stop_auto_connect_joins_thread(self):
        manager = SerialManager()
        with patch.object(manager, "autodetect_port", return_value=None):
            manager.start_auto_connect()
            thread = manager._auto_connect_thread
            manager.stop_auto_connect()
        # Thread foi unida e referência limpa
        assert manager._auto_connect_thread is None
        assert not thread.is_alive()

    def test_stop_auto_connect_is_idempotent(self):
        manager = SerialManager()
        # Parar sem nunca ter iniciado não deve quebrar
        manager.stop_auto_connect()
        assert manager._auto_connect_enabled is False

    def test_connect_reenables_auto_connect(self):
        manager = SerialManager()
        manager._auto_connect_enabled = False
        with patch("app.serial.manager.serial.Serial", return_value=make_serial_mock()):
            manager.connect("COM3")
        try:
            assert manager._auto_connect_enabled is True
        finally:
            teardown(manager)


class TestReadThreadGuard:
    def test_teardown_joins_read_thread(self):
        """Cobertura do fix 3.1: _teardown une a thread de leitura."""
        manager = SerialManager()
        with patch("app.serial.manager.serial.Serial", return_value=make_serial_mock()):
            manager.connect("COM3")
        thread = manager._read_thread
        assert thread is not None and thread.is_alive()
        manager._teardown()
        # Thread de leitura foi encerrada antes de retornar
        assert not thread.is_alive()
        assert manager._read_thread is None

    def test_autodetect_port_no_ports(self):
        manager = SerialManager()
        with patch("app.serial.manager.serial.tools.list_ports.comports", return_value=[]):
            assert manager.autodetect_port() is None

    def test_autodetect_port_arduino_priority(self):
        manager = SerialManager()
        port_arduino = MagicMock()
        port_arduino.description = "Arduino Uno"
        port_arduino.device = "COM5"
        port_other = MagicMock()
        port_other.description = "Some Other Device"
        port_other.device = "COM7"
        with patch(
            "app.serial.manager.serial.tools.list_ports.comports",
            return_value=[port_other, port_arduino],
        ):
            # Deve preferir o Arduino mesmo não sendo o primeiro da lista
            assert manager.autodetect_port() == "COM5"
