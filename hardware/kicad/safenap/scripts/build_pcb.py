"""Gera hardware/kicad/safenap/safenap.kicad_pcb via API oficial de scripting
do KiCad (pcbnew), reaproveitando a mesma topologia de rede (componentes/
pinos/nets) definida em build_schematic.py.

Roteamento: em vez de tentar acertar geometria "a mao" (o que se mostrou
proibitivamente propenso a curto com 5 sinais saindo de um conector denso
do Arduino Nano para colunas espalhadas), isto usa um labirinto/roteador
Lee simples (BFS numa grade 2 camadas) -- cada rede e' roteada em sequencia,
tratando pads de OUTRAS redes como obstaculo e trilhas ja roteadas (de
outras redes) tambem como obstaculo na mesma camada (mas nao na outra,
permitindo cruzar via via). Isso garante uma placa sem curto/cruzamento
por construcao, ao inves de por tentativa-e-erro geometrica.
"""
import heapq
import math
from pathlib import Path

import pcbnew

FP_ROOT = "C:/Program Files/KiCad/10.0/share/kicad/footprints"
PROJECT_DIR = str(Path(__file__).resolve().parent.parent)
PCB_PATH = PROJECT_DIR + r"\safenap.kicad_pcb"

MM = pcbnew.FromMM


def load_fp(lib: str, name: str):
    fp = pcbnew.FootprintLoad(f"{FP_ROOT}/{lib}.pretty", name)
    if fp is None:
        raise RuntimeError(f"Footprint nao encontrado: {lib}:{name}")
    return fp


board = pcbnew.CreateEmptyBoard()

# ---------------------------------------------------------------------------
# 1) Placement (mm)
# ---------------------------------------------------------------------------

placements: dict[str, "pcbnew.FOOTPRINT"] = {}


def place(ref: str, lib: str, name: str, value: str, at_mm: tuple[float, float], rot_deg: float = 0.0):
    fp = load_fp(lib, name)
    fp.SetReference(ref)
    fp.SetValue(value)
    fp.SetPosition(pcbnew.VECTOR2I(MM(at_mm[0]), MM(at_mm[1])))
    if rot_deg:
        fp.SetOrientationDegrees(rot_deg)
    board.Add(fp)
    placements[ref] = fp
    return fp


place("U1", "Module", "Arduino_Nano", "Arduino_Nano_v3.x", (9.0, 22.0), rot_deg=90.0)
place("FSR1", "TerminalBlock", "TerminalBlock_MaiXu_MX126-5.0-02P_1x02_P5.00mm", "FSR-402", (60.0, 10.0))
place("R1", "Resistor_THT", "R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal", "1k", (60.0, 20.0))

# Os 4 motores sempre ligam/desligam juntos (setMotors() no firmware nunca
# os trata individualmente) -- um UNICO estagio (Q2/RB2/D2) aciona os 4 em
# paralelo, em vez de um estagio por motor.
STAGES = [
    {"name": "BUZZER", "ref": "1", "supply": "+5V", "kind": "buzzer"},
    {"name": "MOTORS", "ref": "2", "supply": "+5V", "kind": "motors"},
]

# So' 2 colunas agora (era 5) -- bem mais folga dentro dos mesmos 100x100mm.
for i, stage in enumerate(STAGES):
    col_x = 10.0 + i * 40.0
    place(f"RB{stage['ref']}", "Resistor_THT", "R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal",
          "1k", (col_x, 35.0))
    place(f"Q{stage['ref']}", "Package_TO_SOT_THT", "TO-92_Inline", "BC337", (col_x, 48.0))
    place(f"D{stage['ref']}", "Diode_THT", "D_DO-41_SOD81_P10.16mm_Horizontal", "1N4001", (col_x, 61.0))
    if stage["kind"] == "buzzer":
        place("BUZ1", "Buzzer_Beeper", "MagneticBuzzer_ProSignal_ABI-010-RC", "Buzzer ativo 5V", (col_x, 78.0))
    else:
        # 4 motores em paralelo: todos os "+" na mesma alimentacao, todos os
        # "-" no mesmo no de coletor -- um so' transistor/diodo cobre os 4.
        for m in range(1, 5):
            place(f"M{m}", "TerminalBlock", "TerminalBlock_MaiXu_MX126-5.0-02P_1x02_P5.00mm",
                  "Motor de vibracao 3V DC", (col_x + (m - 1) * 13.0, 78.0))

BOARD_W, BOARD_H = 100.0, 100.0
outline = pcbnew.PCB_SHAPE(board)
outline.SetShape(pcbnew.SHAPE_T_RECT)
outline.SetStart(pcbnew.VECTOR2I(MM(0.0), MM(0.0)))
outline.SetEnd(pcbnew.VECTOR2I(MM(BOARD_W), MM(BOARD_H)))
outline.SetLayer(pcbnew.Edge_Cuts)
outline.SetWidth(MM(0.15))
board.Add(outline)

# ---------------------------------------------------------------------------
# 2) Nets + atribuicao pad -> rede
# ---------------------------------------------------------------------------

NET_NAMES = ["GND", "+5V", "FSR_SIGNAL"]
for stage in STAGES:
    NET_NAMES += [f"{stage['name']}_DRIVE", f"{stage['name']}_BASE", f"{stage['name']}_SW"]

nets: dict[str, "pcbnew.NETINFO_ITEM"] = {}
for name in NET_NAMES:
    net = pcbnew.NETINFO_ITEM(board, name)
    board.Add(net)
    nets[name] = net


def set_pad_net(ref: str, pad_number: str, net_name: str) -> None:
    fp = placements[ref]
    pad = fp.FindPadByNumber(pad_number)
    if pad is None:
        raise RuntimeError(f"Pad {pad_number} nao encontrado em {ref}")
    pad.SetNet(nets[net_name])


PAD_NET: list[tuple[str, str, str]] = []  # (ref, pad_number, net_name) -- tambem usado pelo roteador


def assign(ref: str, pad_number: str, net_name: str) -> None:
    set_pad_net(ref, pad_number, net_name)
    PAD_NET.append((ref, pad_number, net_name))


assign("U1", "4", "GND")  # unico pino de GND do Arduino usado (pedido do usuario)
# Pino 17 (+3V3) nao e' usado: motores foram movidos para +5V (o regulador
# 3.3V do Nano, embutido no chip FTDI/CH340, aguenta so' ~50mA -- muito
# abaixo dos 240-400mA que os 4 motores em paralelo exigem).
assign("U1", "27", "+5V")
assign("U1", "19", "FSR_SIGNAL")
DIGITAL_PIN_OF_STAGE = {"BUZZER": "7", "MOTORS": "8"}
for stage in STAGES:
    assign("U1", DIGITAL_PIN_OF_STAGE[stage["name"]], f"{stage['name']}_DRIVE")

assign("FSR1", "1", "+5V")
assign("FSR1", "2", "FSR_SIGNAL")
assign("R1", "1", "FSR_SIGNAL")
assign("R1", "2", "GND")

for stage in STAGES:
    ref = stage["ref"]
    drive, base, sw = f"{stage['name']}_DRIVE", f"{stage['name']}_BASE", f"{stage['name']}_SW"
    assign(f"RB{ref}", "1", drive)
    assign(f"RB{ref}", "2", base)
    assign(f"Q{ref}", "1", sw)        # C
    assign(f"Q{ref}", "2", base)      # B
    assign(f"Q{ref}", "3", "GND")     # E
    assign(f"D{ref}", "1", stage["supply"])  # K
    assign(f"D{ref}", "2", sw)               # A
    if stage["kind"] == "buzzer":
        assign("BUZ1", "1", stage["supply"])
        assign("BUZ1", "2", sw)
    else:
        # 4 motores em paralelo no mesmo estagio.
        for m in range(1, 5):
            assign(f"M{m}", "1", stage["supply"])
            assign(f"M{m}", "2", sw)

board.BuildListOfNets()

# ---------------------------------------------------------------------------
# 3) Roteador tipo labirinto (Lee/BFS com custo, Dijkstra) em grade 2D x
#    2 camadas (F.Cu / B.Cu). SEM zona/plano de cobre -- pedido explicito
#    do usuario: GND e' uma rede roteada por trilha igual a qualquer outra,
#    sem depender de nenhum preenchimento de cobre da placa.
# ---------------------------------------------------------------------------

GRID = 0.25  # mm por celula -- placa bem mais apertada (10x10cm), precisa
             # de mais resolucao que a v1 (320x110mm) pra sobrar espaco de
             # roteamento entre os pads.
MARGIN = 4.0
GX0, GY0 = MARGIN, MARGIN
GX1, GY1 = BOARD_W - MARGIN, BOARD_H - MARGIN
NCOLS = int((GX1 - GX0) / GRID) + 1
NROWS = int((GY1 - GY0) / GRID) + 1
LAYERS = (pcbnew.F_Cu, pcbnew.B_Cu)

CLEARANCE_MM = 0.25
TRACK_WIDTH_MM = 0.35
# Placa corroida em casa (toner transfer) nao tem furo metalizado -- um
# "via" aqui vira um furo maior que o usuario passa um fio e solda dos dois
# lados a mao depois de corroer. Por isso o diametro/furo sao bem maiores
# que um via industrial (0.8/0.4mm da v1): precisa caber um fio de verdade.
VIA_DIAMETER_MM = 1.6
VIA_DRILL_MM = 0.8
TRACK_OBSTACLE_RADIUS_MM = TRACK_WIDTH_MM / 2.0 + CLEARANCE_MM


def to_cell(x_mm: float, y_mm: float) -> tuple[int, int]:
    return (round((x_mm - GX0) / GRID), round((y_mm - GY0) / GRID))


def to_mm(cx: int, cy: int) -> tuple[float, float]:
    return (GX0 + cx * GRID, GY0 + cy * GRID)


# obstaculo[layer_idx][cy][cx] = net_name que ocupa a celula (ou None)
obstacle: list[list[list[str | None]]] = [
    [[None] * NCOLS for _ in range(NROWS)] for _ in LAYERS
]


def mark_disk(cx: int, cy: int, radius_mm: float, net_name: str, layer_idxs=(0, 1)) -> None:
    # arredonda pra CIMA (nunca pra baixo) -- um raio quantizado por falta
    # deixaria a folga real menor que o pedido, exatamente o tipo de furo
    # que o DRC pegou (violacoes de ~0,002 a 0,17mm: a diferenca de meia
    # celula de grade que "round()" as vezes perde).
    r_cells = max(1, math.ceil(radius_mm / GRID))
    for dy in range(-r_cells, r_cells + 1):
        for dx in range(-r_cells, r_cells + 1):
            if dx * dx + dy * dy > r_cells * r_cells:
                continue
            x, y = cx + dx, cy + dy
            if 0 <= x < NCOLS and 0 <= y < NROWS:
                for li in layer_idxs:
                    if obstacle[li][y][x] is None:
                        obstacle[li][y][x] = net_name


def mark_rect(x0_mm: float, y0_mm: float, x1_mm: float, y1_mm: float, net_name: str, layer_idxs=(0, 1)) -> None:
    """Dilata um retangulo alinhado aos eixos (em mm) e marca as celulas
    dentro dele. Usado pra pads: uma trilha do roteador so' anda na
    horizontal/vertical, entao o pior caso de aproximacao a um pad
    retangular/roundrect e' sempre por um dos 4 lados (nunca pela diagonal
    do canto) -- um retangulo modela isso certo; um CIRCULO (metade da
    diagonal) superestima a folga precisa nos lados e quebra roteamento em
    pads muito proximos (ex.: as 3 pernas de 1,27mm do TO-92)."""
    cx0, cy0 = to_cell(x0_mm, y0_mm)
    cx1, cy1 = to_cell(x1_mm, y1_mm)
    for y in range(max(0, cy0), min(NROWS, cy1 + 1)):
        for x in range(max(0, cx0), min(NCOLS, cx1 + 1)):
            for li in layer_idxs:
                if obstacle[li][y][x] is None:
                    obstacle[li][y][x] = net_name


# Marca todos os pads como obstaculo, EXCETO que cada pad tambem funciona
# como "porta de entrada" livre para a sua PROPRIA rede (feito depois, ao
# rotear, liberando so' a celula exata do pad daquela rede).
#
# Duas passadas: 1) marca so' a celula EXATA de cada pad primeiro (garante
# que a identidade do pad nunca e' "roubada" por um vizinho, o que aconteceria
# em pinos muito proximos -- ex.: as 3 pernas de 1,27mm do TO-92 -- se a
# folga de uma perna alcancasse o centro da vizinha antes dela se marcar);
# 2) so' depois dilata a folga ao redor (retangulo = bounding box real do
# pad, ja rotacionado pelo pcbnew, mais a folga), sem sobrescrever celula
# ja ocupada.
pad_cell_of: dict[tuple[str, str], tuple[int, int]] = {}
pad_bbox_mm: dict[tuple[str, str], tuple[float, float, float, float]] = {}
for fp in board.GetFootprints():
    ref = fp.GetReference()
    for pad in fp.Pads():
        pos = pad.GetPosition()
        x_mm, y_mm = pcbnew.ToMM(pos.x), pcbnew.ToMM(pos.y)
        cx, cy = to_cell(x_mm, y_mm)
        pad_cell_of[(ref, pad.GetNumber())] = (cx, cy)
        bbox = pad.GetBoundingBox()  # ja' inclui rotacao/orientacao real do footprint
        pad_bbox_mm[(ref, pad.GetNumber())] = (
            pcbnew.ToMM(bbox.GetLeft()), pcbnew.ToMM(bbox.GetTop()),
            pcbnew.ToMM(bbox.GetRight()), pcbnew.ToMM(bbox.GetBottom()),
        )
        net_name = pad.GetNetname() or "<pad>"
        obstacle[0][cy][cx] = net_name
        obstacle[1][cy][cx] = net_name

for (ref, padnum), (cx, cy) in pad_cell_of.items():
    fp = placements[ref]
    net_name = fp.FindPadByNumber(padnum).GetNetname() or "<pad>"
    x0, y0, x1, y1 = pad_bbox_mm[(ref, padnum)]
    mark_rect(x0 - TRACK_OBSTACLE_RADIUS_MM, y0 - TRACK_OBSTACLE_RADIUS_MM,
              x1 + TRACK_OBSTACLE_RADIUS_MM, y1 + TRACK_OBSTACLE_RADIUS_MM, net_name)

# ---------------------------------------------------------------------------
# 5) Dijkstra multi-fonte/multi-destino simplificado: conecta os pads de
#    cada rede em sequencia (arvore steiner gulosa) via busca de menor custo
#    numa grade 2-camadas, atravessando so' celulas livres ou da PROPRIA rede.
# ---------------------------------------------------------------------------

MOVES4 = [(1, 0), (-1, 0), (0, 1), (0, -1)]
VIA_COST = 60  # custo extra (em "passos de grade") por trocar de camada.
# Alto de proposito: a checagem de obstaculo ao decidir um via so' confere a
# folga de TRILHA (celula "livre"), nao a folga maior que o proprio corpo do
# via precisa (diametro 1.6mm >> largura de trilha 0.35mm) -- entao pode
# colocar um via "livre" na grade mas encostado demais em algo vizinho na
# escala real. Custo alto faz o roteador preferir esgotar alternativas na
# mesma camada antes de arriscar isso.


def route_net(net_name: str, pad_refs: list[tuple[str, str]]) -> None:
    if len(pad_refs) < 2:
        return
    # Libera as celulas dos proprios pads desta rede (nas 2 camadas, ja que
    # pad THT existe fisicamente nas 2 faces) para servirem de entrada/saida.
    own_cells = set()
    for ref, padnum in pad_refs:
        cx, cy = pad_cell_of[(ref, padnum)]
        own_cells.add((cx, cy))

    def is_free(li: int, x: int, y: int) -> bool:
        if not (0 <= x < NCOLS and 0 <= y < NROWS):
            return False
        occ = obstacle[li][y][x]
        return occ is None or occ == net_name

    via_r_cells = max(1, math.ceil((VIA_DIAMETER_MM / 2.0 + CLEARANCE_MM) / GRID))

    def is_free_for_via(x: int, y: int) -> bool:
        """Um via precisa de folga MAIOR que uma trilha ao redor (diametro
        1.6mm vs 0.35mm de trilha) -- confere um raio de verdade nas 2
        camadas, nao so' a celula exata, senao o via podia cair 'livre' na
        grade mas encostado demais em algo vizinho na escala real (foi
        exatamente esse bug que causou um curto GND/+5V antes desse
        check)."""
        for dy in range(-via_r_cells, via_r_cells + 1):
            for dx in range(-via_r_cells, via_r_cells + 1):
                if dx * dx + dy * dy > via_r_cells * via_r_cells:
                    continue
                nx, ny = x + dx, y + dy
                if not (0 <= nx < NCOLS and 0 <= ny < NROWS):
                    return False
                for li in (0, 1):
                    occ = obstacle[li][ny][nx]
                    if occ is not None and occ != net_name:
                        return False
        return True

    # arvore ja conectada (grid cells que fazem parte da rede ate agora)
    start_cx, start_cy = pad_cell_of[pad_refs[0]]
    tree_cells: set[tuple[int, int, int]] = {(0, start_cx, start_cy), (1, start_cx, start_cy)}
    path_segments: list[list[tuple[int, int, int]]] = []

    # Conecta sempre o pad AINDA NAO LIGADO mais proximo da arvore atual
    # primeiro (Steiner/Prim guloso), em vez de seguir a ordem arbitraria
    # em que o script declara os pads. Ligar na ordem de declaracao criava
    # arvores em "zigue-zague" (ex.: a rede +5V, hoje com 9 pads espalhados
    # de ponta a ponta da placa, saltando entre extremos antes de voltar) --
    # isso empurrava o roteador pra dentro de areas ja congestionadas por
    # outras redes, forcando trocas de camada (via) que uma arvore mais
    # compacta e' capaz de evitar.
    remaining = list(pad_refs[1:])

    while remaining:
        goal_cell_owner: dict[tuple[int, int, int], int] = {}
        for idx, (ref, padnum) in enumerate(remaining):
            gcx, gcy = pad_cell_of[(ref, padnum)]
            goal_cell_owner[(0, gcx, gcy)] = idx
            goal_cell_owner[(1, gcx, gcy)] = idx

        dist: dict[tuple[int, int, int], float] = {}
        prev: dict[tuple[int, int, int], tuple[int, int, int]] = {}
        pq: list[tuple[float, tuple[int, int, int]]] = []
        for cell in tree_cells:
            dist[cell] = 0.0
            heapq.heappush(pq, (0.0, cell))

        found = None
        found_idx = None
        while pq:
            d, cell = heapq.heappop(pq)
            if d > dist.get(cell, float("inf")):
                continue
            if cell in goal_cell_owner:
                found = cell
                found_idx = goal_cell_owner[cell]
                break
            li, x, y = cell
            for dx, dy in MOVES4:
                nx, ny = x + dx, y + dy
                if not is_free(li, nx, ny):
                    continue
                ncell = (li, nx, ny)
                nd = d + 1
                if nd < dist.get(ncell, float("inf")):
                    dist[ncell] = nd
                    prev[ncell] = cell
                    heapq.heappush(pq, (nd, ncell))
            # troca de camada na mesma celula (via) -- exige a folga MAIOR
            # do proprio corpo do via (is_free_for_via), nao so' a celula
            # livre pra trilha.
            oli = 1 - li
            if is_free_for_via(x, y):
                ncell = (oli, x, y)
                nd = d + VIA_COST
                if nd < dist.get(ncell, float("inf")):
                    dist[ncell] = nd
                    prev[ncell] = cell
                    heapq.heappush(pq, (nd, ncell))

        if found is None:
            ref, padnum = remaining[0]
            raise RuntimeError(f"Roteador nao achou caminho para {net_name} ate {ref}.{padnum}")

        del remaining[found_idx]
        path = [found]
        while path[-1] not in tree_cells:
            path.append(prev[path[-1]])
        path.reverse()
        path_segments.append(path)
        for idx, c in enumerate(path):
            tree_cells.add(c)
            li, x, y = c
            # marca a celula central (permite ao PROPRIO net reusar/ramificar
            # dali) e dilata uma folga de isolamento ao redor, so' naquela
            # camada, pra qualquer OUTRA rede nao poder encostar a trilha.
            obstacle[li][y][x] = net_name
            mark_disk(x, y, TRACK_OBSTACLE_RADIUS_MM, net_name, layer_idxs=(li,))
            if idx > 0 and path[idx - 1][1:] == (x, y):
                # troca de camada no mesmo XY = via: bloqueia as DUAS camadas
                # com a folga (maior) do diametro da via.
                mark_disk(x, y, VIA_DIAMETER_MM / 2.0 + CLEARANCE_MM, net_name, layer_idxs=(0, 1))

    # Converte celulas em trilhas reais: agrupa passos retos consecutivos
    # (mesma camada, mesma direcao) num unico segmento; troca de camada vira
    # uma via.
    net = nets[net_name]
    for path in path_segments:
        if len(path) < 2:
            continue
        seg_start = path[0]
        prev = path[0]
        cur_dir = None
        for cell in path[1:]:
            if cell[0] != prev[0]:
                if prev != seg_start:
                    add_track(pt(*to_mm(seg_start[1], seg_start[2])),
                               pt(*to_mm(prev[1], prev[2])), net, LAYERS[seg_start[0]])
                add_via(*to_mm(prev[1], prev[2]), net)
                seg_start = cell
                cur_dir = None
                prev = cell
                continue
            d = (cell[1] - prev[1], cell[2] - prev[2])
            if cur_dir is None:
                cur_dir = d
            elif d != cur_dir:
                add_track(pt(*to_mm(seg_start[1], seg_start[2])),
                           pt(*to_mm(prev[1], prev[2])), net, LAYERS[seg_start[0]])
                seg_start = prev
                cur_dir = d
            prev = cell
        if prev != seg_start:
            add_track(pt(*to_mm(seg_start[1], seg_start[2])),
                       pt(*to_mm(prev[1], prev[2])), net, LAYERS[seg_start[0]])


def pt(x_mm: float, y_mm: float):
    return pcbnew.VECTOR2I(MM(x_mm), MM(y_mm))


def add_track(p1, p2, net, layer) -> None:
    if p1 == p2:
        return
    track = pcbnew.PCB_TRACK(board)
    track.SetStart(p1)
    track.SetEnd(p2)
    track.SetLayer(layer)
    track.SetWidth(MM(TRACK_WIDTH_MM))
    track.SetNet(net)
    board.Add(track)


def add_via(x_mm: float, y_mm: float, net) -> None:
    via = pcbnew.PCB_VIA(board)
    via.SetPosition(pt(x_mm, y_mm))
    via.SetDrill(MM(VIA_DRILL_MM))
    via.SetWidth(MM(VIA_DIAMETER_MM))
    via.SetNet(net)
    board.Add(via)


# Agrupa pads por rede (na ordem em que foram atribuidos) e roteia. TODAS
# as redes, incluindo GND, viram trilha de verdade pelo mesmo roteador --
# sem plano/zona de cobre nenhum (pedido explicito do usuario).
nets_to_pads: dict[str, list[tuple[str, str]]] = {}
for ref, padnum, net_name in PAD_NET:
    nets_to_pads.setdefault(net_name, []).append((ref, padnum))

# GND primeiro: e' a rede mais "espalhada" (4 pads em toda a largura da
# placa) e a que menos importa qual caminho exato ela toma -- roteando com
# a placa ainda vazia (so' os proprios pads como obstaculo), ela pega os
# corredores mais livres, e as redes locais (BASE/SW/DRIVE/FSR_SIGNAL,
# curtas e proximas dos seus proprios componentes) se ajustam ao redor
# depois. +5V (agora com 9 pads -- motores e buzzer compartilham a mesma
# alimentacao) continua por ultimo, se desviando de tudo que ja foi
# colocado -- mas agora a arvore dela e' construida sempre conectando o pad
# geometricamente mais proximo primeiro (ver route_net), nao na ordem
# arbitraria em que o script declara os pads, o que evita zigue-zague
# desnecessario e reduz a chance real de precisar de via.
BUS_NETS_FIRST = ["GND"]
BUS_NETS_LAST = ["+5V"]
ordered_net_names = (
    [n for n in BUS_NETS_FIRST if n in nets_to_pads]
    + [n for n in nets_to_pads if n not in BUS_NETS_FIRST and n not in BUS_NETS_LAST]
    + [n for n in BUS_NETS_LAST if n in nets_to_pads]
)

for net_name in ordered_net_names:
    pads = nets_to_pads[net_name]
    route_net(net_name, pads)

board.BuildListOfNets()

pcbnew.SaveBoard(PCB_PATH, board)
print("Placa escrita em:", PCB_PATH)
