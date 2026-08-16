import ctypes
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8000
VERCEL_ORIGIN = "frontend-rho-umber-oozzreajhq.vercel.app"
MAX_FUNNEL_RESTARTS = 5

_job = None
_kernel32 = None
_procs = {}

CTRL_HANDLER_TYPE = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_uint)


def find_backend_dir() -> Path:
    env = os.environ.get("SAFENAP_BACKEND_DIR")
    if env:
        p = Path(env)
        if (p / "app" / "main.py").exists():
            return p
        sys.exit(f"SAFENAP_BACKEND_DIR invalido: {env}")
    if getattr(sys, "frozen", False):
        here = Path(sys.executable).resolve().parent
    else:
        here = Path(__file__).resolve().parent
    for base in [here, *here.parents]:
        for cand in (base, base / "backend"):
            if (cand / "app" / "main.py").exists() and (cand / ".venv" / "Scripts" / "python.exe").exists():
                return cand
    sys.exit("Backend nao encontrado. Defina SAFENAP_BACKEND_DIR apontando para a pasta backend.")


def setup_kill_on_close_job() -> bool:
    """Job Object: ao fechar/travar/matar este processo, todos os filhos morrem."""
    global _job, _kernel32
    if sys.platform != "win32":
        return False
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.CreateJobObjectW.restype = ctypes.c_void_p
    _kernel32.SetInformationJobObject.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint]
    _kernel32.SetInformationJobObject.restype = ctypes.c_int
    _kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    _kernel32.AssignProcessToJobObject.restype = ctypes.c_int
    _kernel32.TerminateJobObject.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    _kernel32.TerminateJobObject.restype = ctypes.c_int

    class BasicLimit(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerProcessKernelTimeLimit", ctypes.c_int64),
            ("LimitFlags", ctypes.c_uint32),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", ctypes.c_uint32),
            ("Affinity", ctypes.c_void_p),
            ("PriorityClass", ctypes.c_uint32),
            ("SchedulingClass", ctypes.c_uint32),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint64) for n in
                    ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                     "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class ExtendedLimit(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimit),
            ("IoInfo", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    handle = _kernel32.CreateJobObjectW(None, None)
    if not handle:
        print(f"[aviso] CreateJobObject falhou (erro {ctypes.get_last_error()}).")
        return False
    info = ExtendedLimit()
    info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not _kernel32.SetInformationJobObject(handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
        print(f"[aviso] SetInformationJobObject falhou (erro {ctypes.get_last_error()}).")
        return False
    if not _kernel32.AssignProcessToJobObject(handle, _kernel32.GetCurrentProcess()):
        err = ctypes.get_last_error()
        # ERROR_ACCESS_DENIED (5): ja pertence a outro job sem kill-on-close proprio
        print(f"[aviso] Nao foi possivel entrar no Job Object (erro {err}). "
              "Shutdown via janela/finally ainda funciona.")
        return False
    _job = handle
    return True


def assign_to_job(proc) -> None:
    if _kernel32 is None or _job is None or proc is None:
        return
    handle = getattr(proc, "_handle", None)
    if handle:
        _kernel32.AssignProcessToJobObject(_job, handle)


def terminate_job():
    if _kernel32 and _job:
        _kernel32.TerminateJobObject(_job, 0)


def shutdown_all():
    for proc in list(_procs.values()):
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
    for proc in list(_procs.values()):
        if proc and proc.poll() is None:
            try:
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
    if _procs.get("funnel") is not None and tailscale_exe():
        tailscale_run(["funnel", "reset"])
    terminate_job()


@CTRL_HANDLER_TYPE
def _console_ctrl_handler(ctrl_type):
    # CTRL_C=0, CTRL_BREAK=1, CTRL_CLOSE=2, LOGOFF=5, SHUTDOWN=6
    shutdown_all()
    if ctrl_type in (0, 1):
        return 1
    time.sleep(3)  # da tempo de o cleanup completo antes do processo ser morto
    return 0


def install_ctrl_handler():
    if sys.platform == "win32":
        ctypes.windll.kernel32.SetConsoleCtrlHandler(_console_ctrl_handler, 1)


def port_open(port: int, host: str = HOST, timeout: float = 0.5) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((host, port)) == 0


def wait_for_port(port: int, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_open(port):
            return True
        time.sleep(0.4)
    return False


def tailscale_exe():
    return shutil.which("tailscale")


def tailscale_run(args, timeout=20):
    exe = tailscale_exe()
    if not exe:
        return None
    try:
        return subprocess.run([exe] + args, input=b"", capture_output=True, timeout=timeout)
    except Exception:
        return None


def funnel_url():
    r = tailscale_run(["funnel", "status"], timeout=10)
    if not r:
        return None
    text = (r.stdout or b"").decode("utf-8", "ignore") + (r.stderr or b"").decode("utf-8", "ignore")
    for line in text.splitlines():
        line = line.strip().lstrip("#-| ").strip()
        if line.startswith("https://"):
            return line.split()[0]
    return None


def start_funnel():
    exe = tailscale_exe()
    if not exe:
        return None
    proc = subprocess.Popen([exe, "funnel", "--yes", str(PORT)])
    assign_to_job(proc)
    return proc


def main():
    backend_dir = find_backend_dir()
    python_exe = backend_dir / ".venv" / "Scripts" / "python.exe"
    local_only = "--local" in sys.argv[1:]
    ts = tailscale_exe()

    if sys.platform == "win32":
        os.system("title SafeNap Backend")

    install_ctrl_handler()
    setup_kill_on_close_job()

    if port_open(PORT):
        sys.exit(f"Porta {PORT} ja esta em uso. Encerre o processo atual e tente novamente.")

    env = dict(os.environ)
    env.setdefault("VERCEL_URL", VERCEL_ORIGIN)
    env["PYTHONUNBUFFERED"] = "1"

    signal.signal(signal.SIGINT, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))

    print(f"Iniciando API (uvicorn) em {HOST}:{PORT}...")
    api = subprocess.Popen(
        [str(python_exe), "-m", "uvicorn", "app.main:app", "--host", HOST, "--port", str(PORT)],
        cwd=str(backend_dir),
        env=env,
    )
    _procs["api"] = api
    assign_to_job(api)
    if not wait_for_port(PORT, 30):
        shutdown_all()
        sys.exit("API nao subiu em 30s. Verifique os logs acima.")

    funnel = None
    if local_only:
        print("Modo local: Tailscale Funnel ignorado.")
    elif not ts:
        print(f"AVISO: tailscale nao encontrado no PATH. API disponivel somente em {HOST}:{PORT}.")
    else:
        tailscale_run(["funnel", "reset"])
        funnel = start_funnel()
        _procs["funnel"] = funnel

    url = None
    if funnel is not None:
        deadline = time.time() + 15
        while time.time() < deadline:
            url = funnel_url()
            if url:
                break
            time.sleep(1)

    print()
    print("=================================================")
    print(" SafeNap backend no ar")
    print(f"   Local    : http://{HOST}:{PORT}")
    if url:
        print(f"   Publico  : {url}")
        print(f"   WebSocket: {url.replace('https://', 'wss://')}/ws")
    print(" Feche esta janela (ou Ctrl+C) para parar tudo.")
    print("=================================================")
    print()

    restarts = 0
    try:
        while True:
            if api.poll() is not None:
                print("API encerrou. Parando o backend...")
                break
            if funnel is not None and funnel.poll() is not None:
                if restarts < MAX_FUNNEL_RESTARTS:
                    restarts += 1
                    print(f"Funnel caiu. Reiniciando ({restarts}/{MAX_FUNNEL_RESTARTS})...")
                    tailscale_run(["funnel", "reset"])
                    funnel = start_funnel()
                    _procs["funnel"] = funnel
                else:
                    print(f"Funnel falhou {MAX_FUNNEL_RESTARTS} vezes. Seguindo somente em localhost.")
                    funnel = None
                    _procs["funnel"] = None
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nEncerrando...")
    finally:
        shutdown_all()
        print("Backend parado.")


if __name__ == "__main__":
    main()
