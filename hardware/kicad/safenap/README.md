# Hardware SafeNap — projeto KiCad 10

Esquemático (`safenap.kicad_sch`) e placa roteada (`safenap.kicad_pcb`) do
Arduino Nano + FSR-402 + estágios de dreno (buzzer e 4 motores de vibração
em paralelo) descritos em [`docs/HARDWARE.md`](../../../docs/HARDWARE.md).

## Circuito

- **U1** — Arduino Nano v3.x. Só atua (nenhuma lógica de decisão embarcada,
  mesmo princípio do resto do projeto). Usa **um único pino de GND** (pino
  4) — os pinos de GND do módulo Nano são o mesmo nó internamente, então
  usar só um não perde nada eletricamente e simplifica a rede.
- **FSR1 + R1** — divisor de tensão do sensor de força resistivo: FSR-402
  entre `+5V` e `A0`, resistor de pull-down de **1 kΩ** entre `A0` e `GND`
  (valor conferido com o usuário — diferente do que estava documentado
  antes em `docs/HARDWARE.md`; atualizar esse documento se este valor virar
  o padrão do hardware real).
- **Q1/RB1/D1** (buzzer) **+ Q2/RB2/D2** (motores) — só **2 estágios de
  dreno** NPN, não 5. Os 4 motores de vibração sempre ligam/desligam
  juntos no firmware (`setMotors()` nunca os trata individualmente — ver
  `arduino/safenap/safenap.ino`), então em vez de um transistor por motor,
  **um único estágio aciona os 4 em paralelo** a partir de um único pino
  digital (D5). O pino digital do Arduino aciona a base via resistor
  limitador, o transistor faz a chaveação low-side, e o diodo de roda-livre
  protege contra o pico indutivo — isso protege os pinos do Arduino, que
  nunca veem a corrente do atuador diretamente.
  **Cálculo de saturação**: Ib = (5V − 0,7V) / 1kΩ ≈ 4,3mA (bem dentro do
  limite de 20mA/pino do Arduino); com hFE mínimo do BC337 (100), Ic
  suportado em saturação ≈ 430mA. Isso cobre com folga a corrente do buzzer
  (dezenas de mA), mas fica **na borda** da corrente combinada dos 4 motores
  em paralelo a 5V (ver aviso abaixo) — mesmo assim, sem risco de dano ao
  transistor: o limite absoluto do BC337 é Ic contínuo 800mA e potência
  625mW, ambos com folga real mesmo no pior caso.
  ⚠️ **Verificar antes de soldar**: BC337 tem pinagem física C-B-E ou E-B-C
  dependendo do fabricante (diferente do BC547, que é sempre C-B-E) — ver
  aviso detalhado mais abaixo em "Antes de montar: verificação obrigatória".
- **BUZ1** — buzzer ativo de 5V. **M1–M4** — 4 motores de vibração de 3V DC
  **em paralelo** (mesmos 2 nós elétricos: `+5V` e o coletor de Q2) — o
  dreno do buzzer e o dos motores ligam os dois em `+5V` (pedido do
  usuário; antes os motores ligavam em `+3V3`, que é o regulador interno do
  chip FTDI/CH340 do Nano, limitado a ~50mA — muito abaixo dos 240–400mA
  que os 4 motores em paralelo exigem).
  ⚠️ **Motores a 5V, não a 3V (rótulo nominal)**: os motores de vibração
  usados aqui são de 3V DC; alimentá-los a 5V (~67% acima do nominal) tende
  a aumentar a corrente combinada, esquentar mais e encurtar a vida útil do
  motor com o uso repetido — não é destrutivo instantâneo, mas não é o
  ideal para um componente que deve funcionar de forma confiável por anos.
  Mitigação sem tocar no hardware de novo: `PIN_MOTORS` (D5) é um pino PWM
  do Nano — trocar `digitalWrite(PIN_MOTORS, HIGH)` por
  `analogWrite(PIN_MOTORS, ~150)` no firmware reduziria a tensão média
  efetiva nos motores para perto de 3V, sem precisar regenerar a placa.
- FSR-402 e motores são conectados por **borne/terminal de 2 vias**
  (`TerminalBlock_MaiXu_MX126-5.0-02P`, passo 5,08mm) em vez de solda
  direta na placa — eles ficam fisicamente longe dela (empunhadura do
  volante, assento/cinto).

## Placa

- **100 × 100 mm exatos** (contorno em `Edge.Cuts` de (0,0) a (100,100)) —
  pensada pra ser impressa e corroída em casa (toner transfer), não pra
  fabricação industrial.
- 2 camadas, layout com bastante folga agora (só 2 colunas de estágio de
  dreno em vez de 5).
- **Sem plano/zona de cobre nenhum** — pedido explícito do usuário. **Todas
  as redes, incluindo GND**, são trilha roteada igual a qualquer outra
  (BFS/Dijkstra em grade 2 camadas, script próprio — ver
  `scripts/build_pcb.py`), sem depender de nenhum preenchimento de cobre
  da placa. GND é roteada **primeiro** (antes das redes locais) por ser a
  mais "espalhada" (4 pads: Arduino, R1, 2× emissor dos transistores) —
  assim ela pega os corredores mais livres, e as redes locais/barramentos
  se ajustam ao redor dela depois.
- **0 vias**: mesmo com 2 camadas disponíveis, nenhuma rede — incluindo
  GND — precisou trocar de face; tudo fica inteiro em F.Cu ou em B.Cu.
  Não precisa soldar nenhum fio de ligação entre as faces depois de
  corroída, só alinhar bem os dois lados ao furar.
- **0 erros de ERC e 0 de DRC** (verificado com `kicad-cli sch erc` /
  `kicad-cli pcb drc`; ver `erc_report.rpt` / `drc_report.rpt`).

### Corrosão em casa (toner transfer)

- Exportar cada face separadamente antes de imprimir: `kicad-cli pcb export
  svg --layers F.Cu --page-size-mode 2 safenap.kicad_pcb` (idem trocando
  `F.Cu` por `B.Cu`), ou usar o Gerber/PDF direto do KiCad se preferir.
- **Espelhar a face de cima (F.Cu) antes de imprimir** — convenção padrão
  de toner transfer pra que o cobre fique alinhado certo quando a folha é
  virada com o toner contra a placa. A face de baixo (B.Cu) geralmente
  **não** precisa espelhar, mas confirme isso com o processo/software que
  você já usa, já que varia por método (alinhamento por furo vs por borda).
- Trilha mínima usada: 0,35mm; isolamento mínimo: ~0,25–0,35mm (varia por
  trecho, sempre ≥ 0,2mm de regra do projeto). Isso é confortável pra
  corrosão caseira, mas teste um trecho pequeno da sua impressora/ferro de
  passar antes de corroer a placa inteira.
- Fure exatamente no centro de cada pad (a broca certa por padrão de furo
  já está no footprint de cada peça) e alinhe as duas faces usando os
  próprios furos como referência antes de corroer o segundo lado.

## Antes de montar: verificação obrigatória

⚠️ **Pinagem física do BC337 varia por fabricante.** Diferente do BC547
(sempre C-B-E com a face plana virada pra você), o BC337 tem relatos
divergentes entre fabricantes/distribuidores — alguns C-B-E (igual ao
BC547, é o que este projeto assume: pino 1 = Coletor à esquerda, pino 2 =
Base no meio, pino 3 = Emissor à direita, face plana virada pra você),
outros E-B-C. **Antes de soldar Q1 ou Q2:**

1. Confira o datasheet do fabricante específico do seu BC337 (a etiqueta/
   marcação no corpo do transistor identifica o fabricante) — não confie
   em "BC337 = X" genérico de agregador, os fabricantes discordam.
2. Ou meça com multímetro em modo diodo/hFE antes de soldar: identifique
   fisicamente Coletor, Base e Emissor do seu componente específico.
3. Se o seu BC337 for E-B-C (Emissor à esquerda, não Coletor), a solução
   mais simples é **girar o transistor 180°** ao inserir (o footprint TO-92
   não tem chave mecânica que force uma única orientação) — isso troca C↔E
   fisicamente e faz o componente real bater com o que a placa espera.
   Confirme com multímetro depois de montado, antes de ligar o Arduino.

Errar essa etapa não necessariamente queima nada (tensões aqui são baixas),
mas troca Coletor↔Emissor faz o transistor operar em modo inverso, com hFE
muito baixo — o estágio de dreno correspondente não vai conseguir acionar
o motor/buzzer de forma confiável.

**Demais componentes não têm esse risco**: diodo 1N4001 usa a faixa
(catodo) — convenção universal, sem variação por fabricante; borne
`TerminalBlock_MaiXu_MX126-5.0-02P` é passivo (10A/15A conforme datasheet
LCSC, bem acima da corrente real de motor/buzzer); resistores não têm
polaridade.

### Auditoria de conectividade (feita nesta sessão)

Antes de certificar a placa, uma auditoria independente (script à parte,
não o mesmo que gera os arquivos) cruzou, pad a pad:

1. **Esquemático × PCB**: os 33 pares (componente, pino) com rede nomeada
   batem exatamente entre `safenap.kicad_sch` e `safenap.kicad_pcb` — os
   dois arquivos (gerados por scripts separados) não divergiram entre si.
2. **Topologia pretendida × placa real**: todos os 33 pads esperados (com
   base no circuito descrito acima) existem na placa e estão exatamente na
   rede pretendida; nenhuma rede tem pad a mais (nenhum curto por engano).
3. **Continuidade de cobre de verdade** (não só "mesmo nome de rede"):
   confirmado pelo motor de conectividade do próprio KiCad via
   `kicad-cli pcb drc` — 0 violações, 0 pads desconectados.
4. **Pinagem do firmware × pinagem da placa**: D4→buzzer, D5→motores (os 4
   em paralelo), A0→FSR — conferido contra `arduino/safenap/safenap.ino`
   linha a linha, bate exatamente.

O que isso certifica: **a topologia elétrica do design está correta e
internamente consistente**, e a placa gerada é fabricável sem curto/trilha
faltando segundo as regras de projeto. O que isso **não** cobre — e
depende de você na hora da montagem: a etapa de corrosão em si (uma
exposição/revelação ruim pode abrir uma trilha fina ou deixar rebarba de
cobre entre trilhas próximas — sempre confira visualmente/com multímetro
depois de corroída, antes de montar os componentes) e a verificação de
pinagem do BC337 acima.

## Regenerar do zero

Os arquivos `.kicad_sch`/`.kicad_pcb` são **gerados por script**, não
editados à mão (formato S-expression construído a partir de definições de
símbolo/footprint reais extraídas das bibliotecas que já vêm com o KiCad —
ver comentários em `scripts/lib_cache/`). Para regenerar depois de mudar a
topologia elétrica em `scripts/build_schematic.py`:

```bash
"C:\Program Files\KiCad\10.0\bin\python.exe" scripts/build_schematic.py
"C:\Program Files\KiCad\10.0\bin\python.exe" scripts/build_pcb.py
```

(`build_pcb.py` lê a mesma topologia hardcoded a partir do zero — se mudar
pinagem/nets em `build_schematic.py`, replicar a mudança lá também; os dois
scripts não compartilham código ainda, é a limitação principal desta
primeira versão.)

Validar depois de regenerar:

```bash
"C:\Program Files\KiCad\10.0\bin\kicad-cli.exe" sch erc --severity-all safenap.kicad_sch
"C:\Program Files\KiCad\10.0\bin\kicad-cli.exe" pcb drc --severity-all safenap.kicad_pcb
```

## Limitações conhecidas

- Roteamento automático por labirinto prioriza "sem curto" sobre
  estética/comprimento — as trilhas não seguem convenção manual de 45°/90°
  em todo trecho. Eletricamente correto (DRC limpo), mas um roteamento à
  mão ficaria visualmente mais limpo.
- Layout comprimido pra caber em 100×100mm: a folga real entre trilha e pad
  em vários trechos é bem menor que numa placa industrial (~0,25–0,35mm,
  contra 1mm+ que seria confortável numa placa maior). Fabricação
  profissional aceitaria isso numa boa; corrosão caseira é mais sensível a
  imperfeição de exposição/revelação — se a sua impressora/processo não
  reproduz trilha fina de forma confiável, pode precisar aumentar
  `TRACK_WIDTH_MM`/`CLEARANCE_MM` em `scripts/build_pcb.py` e regenerar (o
  que pode não caber mais nos 100×100mm sem repensar o layout).
- Nenhum componente foi testado em placa física fabricada de verdade —
  isso é projeto/design, não fabricação nem bring-up.
- `build_schematic.py` e `build_pcb.py` duplicam a topologia elétrica
  (pinagem, nomes de rede) em vez de compartilhar uma única fonte da
  verdade — risco de divergência se um for editado sem o outro.
