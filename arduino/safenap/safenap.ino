// Pinagem historica (confirmada pelo firmware original das simulacoes do
// TCC): buzzer no pino 4, quatro motores de vibracao nos pinos 5-8, LED
// embutido no pino 13, sensor de pressao FSR-402 no pino analogico A0.
const int PIN_BUZZER = 4;
const int PIN_MOTOR_1 = 5;
const int PIN_MOTOR_2 = 6;
const int PIN_MOTOR_3 = 7;
const int PIN_MOTOR_4 = 8;
const int PIN_LED = 13;

// Sensor de pressao FSR-402 (empunhadura do volante): UM sensor, divisor
// de tensao com resistor fixo de 10k ohm entre o pino analogico e o GND
// (ver docs/HARDWARE.md para o esquema completo). O Arduino so le e
// transmite o valor cru — toda a interpretacao (baseline, limiar,
// debounce) fica no backend Python (GripMonitor), mesmo principio ja
// usado para ALARM/VIBRATION: o firmware nao decide nada sobre
// sonolencia (diferente do firmware historico, que fazia essa fusao e a
// temporizacao do alerta no proprio Arduino).
const int PIN_FSR = A0;
const unsigned long FSR_INTERVAL_MS = 200; // ~5 leituras/s
unsigned long lastFsrSentAt = 0;

String inputString = "";
bool stringComplete = false;

void setup() {
  Serial.begin(9600);

  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_MOTOR_1, OUTPUT);
  pinMode(PIN_MOTOR_2, OUTPUT);
  pinMode(PIN_MOTOR_3, OUTPUT);
  pinMode(PIN_MOTOR_4, OUTPUT);

  allActuatorsOff();

  inputString.reserve(50);

  // Confirmação de boot
  Serial.println("SAFENAP_READY");
}

void loop() {
  if (stringComplete) {
    inputString.trim(); // Remove \n \r

    if (inputString == "ALARM_ON") {
      digitalWrite(PIN_BUZZER, HIGH);
      setMotors(HIGH);
      digitalWrite(PIN_LED, HIGH);
      Serial.println("OK:ALARM_ON");
    }
    else if (inputString == "ALARM_OFF") {
      allActuatorsOff();
      Serial.println("OK:ALARM_OFF");
    }
    else if (inputString == "VIBRATION_ON") {
      setMotors(HIGH);
      digitalWrite(PIN_LED, HIGH);
      Serial.println("OK:VIBRATION_ON");
    }
    else if (inputString == "VIBRATION_OFF") {
      setMotors(LOW);
      digitalWrite(PIN_LED, LOW);
      Serial.println("OK:VIBRATION_OFF");
    }
    else if (inputString == "STATUS") {
      Serial.println("OK:STATUS_ONLINE");
    }
    else {
      Serial.print("ERR:UNKNOWN_COMMAND_");
      Serial.println(inputString);
    }

    // Limpa a string
    inputString = "";
    stringComplete = false;
  }

  sendFsrReadingIfDue();
}

void setMotors(int state) {
  digitalWrite(PIN_MOTOR_1, state);
  digitalWrite(PIN_MOTOR_2, state);
  digitalWrite(PIN_MOTOR_3, state);
  digitalWrite(PIN_MOTOR_4, state);
}

void allActuatorsOff() {
  digitalWrite(PIN_BUZZER, LOW);
  setMotors(LOW);
  digitalWrite(PIN_LED, LOW);
}

// Streaming nao bloqueante (millis(), sem delay()) para nao atrasar o
// processamento de comandos recebidos via serialEvent().
void sendFsrReadingIfDue() {
  unsigned long now = millis();
  if (now - lastFsrSentAt < FSR_INTERVAL_MS) {
    return;
  }
  lastFsrSentAt = now;

  int value = analogRead(PIN_FSR);

  Serial.print("FSR:");
  Serial.println(value);
}

void serialEvent() {
  while (Serial.available()) {
    char inChar = (char)Serial.read();
    inputString += inChar;
    if (inChar == '\n') {
      stringComplete = true;
    }
  }
}
