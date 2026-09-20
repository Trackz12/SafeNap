"""Gera hardware/kicad/safenap/safenap.kicad_sch programaticamente,
usando definicoes de simbolo REAIS extraidas das bibliotecas que vem com
o KiCad 10.0 (nao inventadas), para evitar erro de sintaxe S-expression.

Roda com o Python do proprio KiCad soh por conveniencia (no interpreter
extra needed), mas nao usa nenhuma API do KiCad -- eh geracao de texto pura.
"""
import json
import re
import uuid
from pathlib import Path

SCRATCH = Path(__file__).resolve().parent / "lib_cache"
PROJECT_DIR = Path(__file__).resolve().parent.parent
PROJECT_NAME = "safenap"

extracted = json.loads((SCRATCH / "extracted_symbols.json").read_text(encoding="utf-8"))
arduino_v2 = (SCRATCH / "arduino_nano_v2_symbol.txt").read_text(encoding="utf-8")
arduino_v3 = (SCRATCH / "arduino_nano_symbol.txt").read_text(encoding="utf-8")


def new_uuid() -> str:
    return str(uuid.uuid4())


ROOT_UUID = new_uuid()
SCH_UUID = ROOT_UUID  # raiz de folha unica: o path de instancia eh "/" + uuid do proprio arquivo


# ---------------------------------------------------------------------------
# 1) Resolver simbolos que usam "extends" na biblioteca original, porque o
#    cache lib_symbols de um .kicad_sch precisa da definicao COMPLETA
#    (grafismo + pinos), nao da referencia "extends".
# ---------------------------------------------------------------------------

def resolve_extends(block: str, old_name: str, new_name: str, overrides: dict[str, str]) -> str:
    """Renomeia old_name -> new_name em todas as ocorrencias (nome principal
    e sub-unidades tipo Nome_0_1/Nome_1_1) e sobrescreve propriedades."""
    resolved = block.replace(old_name, new_name)
    for prop, value in overrides.items():
        resolved = re.sub(
            rf'(\(property "{prop}" ")[^"]*(")',
            lambda m, v=value: m.group(1) + v + m.group(2),
            resolved,
            count=1,
        )
    return resolved


# Nota (testado empiricamente): o cache lib_symbols de um .kicad_sch NAO
# resolve corretamente uma entrada que usa "(extends "...")" apontando para
# outra entrada do proprio cache -- tentar manter a forma "extends" (igual a
# biblioteca original) faz o eeschema perder a geometria/posicao de TODOS os
# pinos do simbolo derivado (BC337, Arduino_Nano_v3.x), quebrando a conexao
# eletrica em massa no ERC. A forma que funciona de verdade e' a "achatada":
# copiar o grafismo/pinos do simbolo base para dentro do derivado, sob o
# nome do derivado. Isso deixa so um aviso cosmetico (lib_symbol_mismatch,
# 'cache difere da biblioteca no disco') que nao afeta netlist nem PCB.
#
# BC337 (nao BC547): mesmo simbolo-base "Q_NPN_CBE" e mesmo footprint
# TO-92_Inline na biblioteca oficial do KiCad (pinagem 1=C, 2=B, 3=E
# identica), so' com corrente de coletor maior (0.8A vs 0.1A do BC547) --
# troca direta, sem mudar footprint nem pinagem.
bc337_resolved = resolve_extends(
    extracted["Q_NPN_CBE"],
    "Q_NPN_CBE",
    "BC337",
    {
        "Value": "BC337",
        "Footprint": "Package_TO_SOT_THT:TO-92_Inline",
        "Datasheet": "https://diotec.com/tl_files/diotec/files/pdf/datasheets/bc337.pdf",
        "Description": "0.8A Ic, 45V Vce, NPN Transistor, TO-92 (driver de dreno para atuador)",
    },
)

arduino_nano_v3_resolved = resolve_extends(
    arduino_v2,
    "Arduino_Nano_v2.x",
    "Arduino_Nano_v3.x",
    {
        "Value": "Arduino_Nano_v3.x",
        "Datasheet": "http://www.mouser.com/pdfdocs/Gravitech_Arduino_Nano3_0.pdf",
        "Description": "Arduino Nano v3.x",
    },
)

LIB_BLOCKS = {
    ("MCU_Module", "Arduino_Nano_v3.x"): arduino_nano_v3_resolved,
    ("Transistor_BJT", "BC337"): bc337_resolved,
    ("Diode", "1N4001"): extracted["1N4001"],
    ("Device", "R"): extracted["R"],
    ("Device", "R_Variable"): extracted["R_Variable"],
    ("Motor", "Motor_DC"): extracted["Motor_DC"],
    ("Device", "Buzzer"): extracted["Buzzer"],
    ("power", "+5V"): extracted["+5V"],
    ("power", "GND"): extracted["GND"],
    ("power", "PWR_FLAG"): extracted["PWR_FLAG"],
}

lib_symbols_parts = []
for (lib, name), block in LIB_BLOCKS.items():
    full_id = f"{lib}:{name}"
    prefixed = block.replace(f'(symbol "{name}"', f'(symbol "{full_id}"', 1)
    lib_symbols_parts.append(prefixed)

LIB_SYMBOLS_SECTION = "\t(lib_symbols\n" + "\n".join(lib_symbols_parts) + "\n\t)\n"


# ---------------------------------------------------------------------------
# 2) Pinagem (numero -> deslocamento local relativo a origem do simbolo,
#    quando o simbolo esta na rotacao/orientacao padrao usada aqui: angle 0,
#    sem espelhamento). Extraida diretamente dos blocos acima.
# ---------------------------------------------------------------------------

ARDUINO_PINS = {
    "1": (-12.7, 12.7), "2": (-12.7, 15.24), "3": (12.7, 12.7), "4": (0, -25.4),
    "5": (-12.7, 10.16), "6": (-12.7, 7.62), "7": (-12.7, 5.08), "8": (-12.7, 2.54),
    "9": (-12.7, 0), "10": (-12.7, -2.54), "11": (-12.7, -5.08), "12": (-12.7, -7.62),
    "13": (-12.7, -10.16), "14": (-12.7, -12.7), "15": (-12.7, -15.24), "16": (-12.7, -17.78),
    "17": (2.54, 25.4), "18": (12.7, 5.08), "19": (12.7, 0), "20": (12.7, -2.54),
    "21": (12.7, -5.08), "22": (12.7, -7.62), "23": (12.7, -10.16), "24": (12.7, -12.7),
    "25": (12.7, -15.24), "26": (12.7, -17.78), "27": (5.08, 25.4), "28": (12.7, 15.24),
    "29": (2.54, -25.4), "30": (-2.54, 25.4),
}
BC337_PINS = {"1": (2.54, 5.08), "2": (-5.08, 0), "3": (2.54, -5.08)}  # C, B, E
DIODE_PINS = {"1": (-3.81, 0), "2": (3.81, 0)}  # K, A
RESISTOR_PINS = {"1": (0, 3.81), "2": (0, -3.81)}
MOTOR_PINS = {"1": (0, 5.08), "2": (0, -7.62)}  # +, -
BUZZER_PINS = {"1": (-2.54, 2.54), "2": (-2.54, -2.54)}  # +, -
POWER_PIN = {"1": (0, 0)}


# ---------------------------------------------------------------------------
# 3) Helpers de geracao de texto S-expression
# ---------------------------------------------------------------------------

def fnum(x: float) -> str:
    """Formata coordenadas evitando lixo de ponto flutuante binario
    (ex.: 105.08000000000001), que o parser do KiCad rejeita."""
    return f"{round(x, 4):g}"


def prop(name: str, value: str, at: tuple[float, float], hide: bool = False) -> str:
    hide_txt = "\n\t\t\t\t(hide yes)" if hide else ""
    return (
        f'\t\t(property "{name}" "{value}"\n'
        f'\t\t\t(at {fnum(at[0])} {fnum(at[1])} 0)\n'
        f'\t\t\t(effects\n'
        f'\t\t\t\t(font\n'
        f'\t\t\t\t\t(size 1.27 1.27)\n'
        f'\t\t\t\t)'
        f'{hide_txt}\n'
        f'\t\t\t)\n'
        f'\t\t)'
    )


def symbol_instance(
    lib_id: str,
    ref: str,
    value: str,
    footprint: str,
    at: tuple[float, float],
    pins: dict[str, tuple[float, float]],
    datasheet: str = "~",
    description: str = "",
    hide_ref: bool = False,
) -> str:
    x, y = at
    parts = [
        "\t(symbol",
        f'\t\t(lib_id "{lib_id}")',
        f"\t\t(at {fnum(x)} {fnum(y)} 0)",
        "\t\t(unit 1)",
        "\t\t(exclude_from_sim no)",
        "\t\t(in_bom yes)",
        "\t\t(on_board yes)",
        "\t\t(dnp no)",
        f'\t\t(uuid "{new_uuid()}")',
        prop("Reference", ref, (x, y - 5), hide=hide_ref),
        prop("Value", value, (x, y + 5), hide=hide_ref),
        prop("Footprint", footprint, (x, y), hide=True),
        prop("Datasheet", datasheet, (x, y), hide=True),
        prop("Description", description, (x, y), hide=True),
    ]
    for num in pins:
        parts.append(f'\t\t(pin "{num}"\n\t\t\t(uuid "{new_uuid()}")\n\t\t)')
    parts.append(
        "\t\t(instances\n"
        f'\t\t\t(project "{PROJECT_NAME}"\n'
        f'\t\t\t\t(path "/{ROOT_UUID}"\n'
        f'\t\t\t\t\t(reference "{ref}")\n'
        "\t\t\t\t\t(unit 1)\n"
        "\t\t\t\t)\n"
        "\t\t\t)\n"
        "\t\t)"
    )
    parts.append("\t)")
    return "\n".join(parts)


_pwr_counter = [0]


def power_symbol(kind: str, at: tuple[float, float]) -> str:
    """kind: '+5V' | 'GND'"""
    _pwr_counter[0] += 1
    ref = f"#PWR{_pwr_counter[0]:03d}"
    x, y = at
    return (
        "\t(symbol\n"
        f'\t\t(lib_id "power:{kind}")\n'
        f"\t\t(at {fnum(x)} {fnum(y)} 0)\n"
        "\t\t(unit 1)\n"
        "\t\t(exclude_from_sim no)\n"
        "\t\t(in_bom yes)\n"
        "\t\t(on_board yes)\n"
        "\t\t(dnp no)\n"
        f'\t\t(uuid "{new_uuid()}")\n'
        + prop("Reference", ref, (x, y - 3.81), hide=True) + "\n"
        + prop("Value", kind, (x, y + 3.556), hide=False) + "\n"
        + prop("Footprint", "", (x, y), hide=True) + "\n"
        + prop("Datasheet", "", (x, y), hide=True) + "\n"
        + prop("Description", f'Power symbol creates a global label with name \\"{kind}\\"', (x, y), hide=True) + "\n"
        + f'\t\t(pin "1"\n\t\t\t(uuid "{new_uuid()}")\n\t\t)\n'
        + "\t\t(instances\n"
        f'\t\t\t(project "{PROJECT_NAME}"\n'
        f'\t\t\t\t(path "/{ROOT_UUID}"\n'
        f'\t\t\t\t\t(reference "{ref}")\n'
        "\t\t\t\t\t(unit 1)\n"
        "\t\t\t\t)\n"
        "\t\t\t)\n"
        "\t\t)\n"
        "\t)"
    )


_flag_counter = [0]


def pwr_flag_symbol(at: tuple[float, float]) -> str:
    """PWR_FLAG: unico pino do tipo 'power_out' de toda a lib padrao do
    KiCad. GND (assim como +5V) e' eletricamente 'power_in' -- ao
    contrario de +5V, a rede GND deste projeto nao tem nenhum pino
    'power_out' verdadeiro nela (nenhum componente "gera" GND), entao o ERC
    aponta 'Input Power pin not driven' pra rede inteira. O PWR_FLAG existe
    exatamente pra isso: diz ao ERC "esta rede tem alimentacao valida mesmo
    sem uma fonte eletricamente ativa", uso padrao em qualquer projeto
    KiCad com um sinal de referencia (GND) sem regulador/fonte no proprio
    esquematico."""
    _flag_counter[0] += 1
    ref = f"#FLG{_flag_counter[0]:03d}"
    x, y = at
    return (
        "\t(symbol\n"
        '\t\t(lib_id "power:PWR_FLAG")\n'
        f"\t\t(at {fnum(x)} {fnum(y)} 0)\n"
        "\t\t(unit 1)\n"
        "\t\t(exclude_from_sim no)\n"
        "\t\t(in_bom yes)\n"
        "\t\t(on_board yes)\n"
        "\t\t(dnp no)\n"
        f'\t\t(uuid "{new_uuid()}")\n'
        + prop("Reference", ref, (x, y - 3.81), hide=True) + "\n"
        + prop("Value", "PWR_FLAG", (x, y + 3.81), hide=False) + "\n"
        + prop("Footprint", "", (x, y), hide=True) + "\n"
        + prop("Datasheet", "", (x, y), hide=True) + "\n"
        + prop("Description", "Special symbol for telling ERC where power comes from", (x, y), hide=True) + "\n"
        + f'\t\t(pin "1"\n\t\t\t(uuid "{new_uuid()}")\n\t\t)\n'
        + "\t\t(instances\n"
        f'\t\t\t(project "{PROJECT_NAME}"\n'
        f'\t\t\t\t(path "/{ROOT_UUID}"\n'
        f'\t\t\t\t\t(reference "{ref}")\n'
        "\t\t\t\t\t(unit 1)\n"
        "\t\t\t\t)\n"
        "\t\t\t)\n"
        "\t\t)\n"
        "\t)"
    )


def wire(p1: tuple[float, float], p2: tuple[float, float]) -> str:
    return (
        "\t(wire\n"
        "\t\t(pts\n"
        f"\t\t\t(xy {fnum(p1[0])} {fnum(p1[1])}) (xy {fnum(p2[0])} {fnum(p2[1])})\n"
        "\t\t)\n"
        "\t\t(stroke\n"
        "\t\t\t(width 0)\n"
        "\t\t\t(type solid)\n"
        "\t\t)\n"
        f'\t\t(uuid "{new_uuid()}")\n'
        "\t)"
    )


def label(text: str, at: tuple[float, float], angle: int = 0, justify: str = "left bottom") -> str:
    return (
        f'\t(label "{text}"\n'
        f"\t\t(at {fnum(at[0])} {fnum(at[1])} {angle})\n"
        "\t\t(effects\n"
        "\t\t\t(font\n"
        "\t\t\t\t(size 1.27 1.27)\n"
        "\t\t\t)\n"
        f"\t\t\t(justify {justify})\n"
        "\t\t)\n"
        f'\t\t(uuid "{new_uuid()}")\n'
        "\t)"
    )


def no_connect(at: tuple[float, float]) -> str:
    return f'\t(no_connect\n\t\t(at {fnum(at[0])} {fnum(at[1])})\n\t\t(uuid "{new_uuid()}")\n\t)'


# ---------------------------------------------------------------------------
# 4) Rede: conecta um pino (ponto absoluto) a um nome de rede via um toco de
#    fio curto + rotulo local (mesmo padrao do template oficial da Arduino
#    Nano: rotulos com o mesmo nome em pontos diferentes formam a mesma rede,
#    sem precisar de um fio continuo entre os dois componentes).
# ---------------------------------------------------------------------------

STUB_LEN = 2.54


def stub_and_label(pin_abs: tuple[float, float], direction: tuple[float, float], net_name: str) -> list[str]:
    px, py = pin_abs
    dx, dy = direction
    end = (px + dx * STUB_LEN, py + dy * STUB_LEN)
    if dx > 0:
        justify, angle = "left bottom", 0
    elif dx < 0:
        justify, angle = "right bottom", 0
    elif dy > 0:
        justify, angle = "left bottom", 90
    else:
        justify, angle = "left bottom", 270
    return [wire(pin_abs, end), label(net_name, end, angle=angle, justify=justify)]


def stub_and_power(pin_abs: tuple[float, float], direction: tuple[float, float], kind: str) -> list[str]:
    px, py = pin_abs
    dx, dy = direction
    end = (px + dx * STUB_LEN, py + dy * STUB_LEN)
    return [wire(pin_abs, end), power_symbol(kind, end)]


def abs_pin(origin: tuple[float, float], local: tuple[float, float]) -> tuple[float, float]:
    """As coordenadas dos pinos dentro de um .kicad_sym usam +Y para cima
    (convencao matematica), mas a folha do esquematico usa +Y para baixo
    -- por isso o eixo Y do deslocamento local precisa ser invertido ao
    somar com a posicao (origin) do simbolo no esquematico."""
    return (origin[0] + local[0], origin[1] - local[1])


# ---------------------------------------------------------------------------
# 5) Montagem do circuito
# ---------------------------------------------------------------------------

def snap(v: float) -> float:
    """Arredonda para o multiplo de grade mais proximo (1.27mm = 50 mil),
    a mesma grade de conexao que o KiCad usa; evita avisos de
    'endpoint off grid' e garante que origem-de-simbolo + deslocamento-de-
    pino caia num ponto onde fios/rotulos realmente se conectam."""
    return round(round(v / 1.27) * 1.27, 2)


def sp(x: float, y: float) -> tuple[float, float]:
    return (snap(x), snap(y))


body: list[str] = []

U1 = sp(100.0, 100.0)
body.append(
    symbol_instance(
        "MCU_Module:Arduino_Nano_v3.x", "U1", "Arduino_Nano_v3.x", "Module:Arduino_Nano", U1, ARDUINO_PINS,
        datasheet="http://www.mouser.com/pdfdocs/Gravitech_Arduino_Nano3_0.pdf",
        description="Arduino Nano v3.x - controlador do SafeNap (sem logica de decisao, so atuacao)",
    )
)

# GND / +5V diretos do Arduino
gnd1 = abs_pin(U1, ARDUINO_PINS["4"])
gnd1_end = (gnd1[0] + STUB_LEN, gnd1[1])
body.append(wire(gnd1, gnd1_end))
body.append(power_symbol("GND", gnd1_end))
# PWR_FLAG na rede GND: GND e' 'power_in' em todo mundo (nenhum componente
# deste projeto realmente "gera" GND), entao o ERC precisa desse sinalizador
# uma unica vez em qualquer ponto da rede (rede e' global, nao importa onde).
flag_pos = (gnd1_end[0] + STUB_LEN, gnd1_end[1])
body.append(wire(gnd1_end, flag_pos))
body.append(pwr_flag_symbol(flag_pos))

body += stub_and_power(abs_pin(U1, ARDUINO_PINS["27"]), (0, -1), "+5V")

# Pinos nao usados -> no-connect (mantem o ERC limpo). Pino 29 (GND) entra
# aqui: usamos so' UM pino de GND do Arduino (pino 4), nao os dois -- pedido
# do usuario, simplifica a rede sem perda eletrica (os dois pinos de GND
# do Nano sao o mesmo no interno da placa do modulo). Pino 17 (+3V3) entra
# aqui tambem: os motores foram movidos para +5V (o regulador 3.3V do Nano,
# embutido no chip FTDI/CH340, aguenta so' ~50mA -- muito abaixo dos
# 240-400mA que os 4 motores em paralelo exigem), entao o pino 3V3 do
# Arduino nao alimenta mais nada neste projeto.
UNUSED_PINS = ["1", "2", "3", "5", "6", "9", "10", "11", "12", "13", "14", "15", "16",
               "17", "18", "20", "21", "22", "23", "24", "25", "26", "28", "29", "30"]
for pn in UNUSED_PINS:
    body.append(no_connect(abs_pin(U1, ARDUINO_PINS[pn])))

# --- FSR-402 (divisor de tensao: FSR entre +5V e A0, pull-down de 1k para GND) ---
FSR1 = sp(60.0, 40.0)
R1 = sp(60.0, 20.0)
body.append(symbol_instance("Device:R_Variable", "FSR1", "FSR-402",
                             "TerminalBlock:TerminalBlock_MaiXu_MX126-5.0-02P_1x02_P5.00mm", FSR1, RESISTOR_PINS,
                             description="Sensor de forca resistivo (empunhadura do volante)"))
body.append(symbol_instance("Device:R", "R1", "1k", "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal",
                             R1, RESISTOR_PINS, description="Pull-down do divisor de tensao do FSR-402"))

body += stub_and_power(abs_pin(FSR1, RESISTOR_PINS["1"]), (0, 1), "+5V")
body += stub_and_label(abs_pin(FSR1, RESISTOR_PINS["2"]), (0, -1), "FSR_SIGNAL")
body += stub_and_label(abs_pin(R1, RESISTOR_PINS["1"]), (0, 1), "FSR_SIGNAL")
body += stub_and_power(abs_pin(R1, RESISTOR_PINS["2"]), (0, -1), "GND")
body += stub_and_label(abs_pin(U1, ARDUINO_PINS["19"]), (1, 0), "FSR_SIGNAL")

# --- Estagios de dreno (NPN + resistor de base + diodo de roda-livre) ---
# Os 4 motores SEMPRE ligam/desligam juntos (setMotors() no firmware nunca
# os trata individualmente) -- por isso um UNICO estagio (Q2/RB2/D2) aciona
# os 4 em paralelo a partir de um UNICO pino digital (D5), em vez de um
# estagio por motor. BC337 aguenta a corrente combinada dos 4 (tipicamente
# 240-400mA, contra 800mA de Ic maximo do BC337).
STAGES = [
    {"name": "BUZZER", "ref": "1", "digital_pin": "7", "supply": "+5V", "kind": "buzzer"},
    {"name": "MOTORS", "ref": "2", "digital_pin": "8", "supply": "+5V", "kind": "motors"},
]

for i, stage in enumerate(STAGES):
    col_x = 180.0 + i * 45.72
    rb_pos = sp(col_x, 100.0)
    q_pos = sp(col_x + 15.24, 90.0)
    d_pos = sp(col_x + 15.24, 60.0)
    act_pos = sp(col_x + 15.24, 40.0)

    drive_net = f"{stage['name']}_DRIVE"
    base_net = f"{stage['name']}_BASE"
    sw_net = f"{stage['name']}_SW"

    # Pino digital do Arduino -> resistor de base
    body += stub_and_label(abs_pin(U1, ARDUINO_PINS[stage["digital_pin"]]), (-1, 0), drive_net)
    body.append(symbol_instance("Device:R", f"RB{stage['ref']}", "1k",
                                 "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal",
                                 rb_pos, RESISTOR_PINS, description=f"Resistor de base de Q{stage['ref']}"))
    body += stub_and_label(abs_pin(rb_pos, RESISTOR_PINS["1"]), (0, 1), drive_net)
    body += stub_and_label(abs_pin(rb_pos, RESISTOR_PINS["2"]), (0, -1), base_net)

    # Transistor NPN (dreno / low-side switch)
    body.append(symbol_instance("Transistor_BJT:BC337", f"Q{stage['ref']}", "BC337",
                                 "Package_TO_SOT_THT:TO-92_Inline", q_pos, BC337_PINS,
                                 description=f"Estagio de dreno do atuador {stage['name']}"))
    body += stub_and_label(abs_pin(q_pos, BC337_PINS["2"]), (-1, 0), base_net)
    body += stub_and_label(abs_pin(q_pos, BC337_PINS["1"]), (0, 1), sw_net)
    body += stub_and_power(abs_pin(q_pos, BC337_PINS["3"]), (0, -1), "GND")

    # Diodo de roda-livre (flyback), catodo na alimentacao, anodo no coletor
    body.append(symbol_instance("Diode:1N4001", f"D{stage['ref']}", "1N4001",
                                 "Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal", d_pos, DIODE_PINS,
                                 description=f"Diodo de roda-livre do atuador {stage['name']}"))
    body += stub_and_power(abs_pin(d_pos, DIODE_PINS["1"]), (-1, 0), stage["supply"])
    body += stub_and_label(abs_pin(d_pos, DIODE_PINS["2"]), (1, 0), sw_net)

    # Atuador
    if stage["kind"] == "buzzer":
        body.append(symbol_instance("Device:Buzzer", "BUZ1", "Buzzer ativo 5V",
                                     "Buzzer_Beeper:MagneticBuzzer_ProSignal_ABI-010-RC", act_pos, BUZZER_PINS,
                                     description="Buzzer ativo de alarme sonoro"))
        body += stub_and_power(abs_pin(act_pos, BUZZER_PINS["1"]), (-1, 0), stage["supply"])
        body += stub_and_label(abs_pin(act_pos, BUZZER_PINS["2"]), (-1, 0), sw_net)
    else:
        # 4 motores em paralelo: todos os "+" na mesma alimentacao, todos os
        # "-" no mesmo no de coletor (sw_net) -- um unico transistor/diodo
        # ja cobre os 4.
        for m in range(1, 5):
            m_pos = sp(act_pos[0] + (m - 1) * 20.0, act_pos[1])
            body.append(symbol_instance("Motor:Motor_DC", f"M{m}", "Motor de vibracao 3V DC",
                                         "TerminalBlock:TerminalBlock_MaiXu_MX126-5.0-02P_1x02_P5.00mm",
                                         m_pos, MOTOR_PINS,
                                         description=f"Motor de vibracao {m} (assento/cinto)"))
            body += stub_and_power(abs_pin(m_pos, MOTOR_PINS["1"]), (0, 1), stage["supply"])
            body += stub_and_label(abs_pin(m_pos, MOTOR_PINS["2"]), (0, -1), sw_net)


# ---------------------------------------------------------------------------
# 6) Monta o arquivo .kicad_sch completo
# ---------------------------------------------------------------------------

sch = (
    "(kicad_sch\n"
    "\t(version 20250114)\n"
    '\t(generator "eeschema")\n'
    '\t(generator_version "10.0")\n'
    f'\t(uuid "{SCH_UUID}")\n'
    '\t(paper "A3")\n'
    "\t(title_block\n"
    '\t\t(title "SafeNap - Hardware embarcado (Arduino Nano)")\n'
    '\t\t(date "2026-09-09")\n'
    '\t\t(rev "1.0")\n'
    '\t\t(company "SafeNap - TCC")\n'
    '\t\t(comment 1 "FSR-402 (empunhadura) + estagios de dreno NPN para buzzer e 4 motores de vibracao")\n'
    "\t)\n"
    + LIB_SYMBOLS_SECTION
    + "\n".join(body)
    + "\n\t(sheet_instances\n"
    '\t\t(path "/"\n'
    '\t\t\t(page "1")\n'
    "\t\t)\n"
    "\t)\n"
    "\t(embedded_fonts no)\n"
    ")\n"
)

def write_sch(text: str, path=None):
    path = path or (PROJECT_DIR / f"{PROJECT_NAME}.kicad_sch")
    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(text, encoding="utf-8")
    return path


if __name__ == "__main__":
    p = write_sch(sch)
    print("Escrito:", p, "-", len(sch), "bytes")
