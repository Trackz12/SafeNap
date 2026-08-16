const int PIN_LED = 13;        // LED embutido ou externo
const int PIN_BUZZER = 8;      // Pino do Buzzer
const int PIN_VIBRATION = 9;   // Pino do Motor de Vibração

String inputString = "";
bool stringComplete = false;

void setup() {
  Serial.begin(9600);
  
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_VIBRATION, OUTPUT);
  
  digitalWrite(PIN_LED, LOW);
  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_VIBRATION, LOW);
  
  inputString.reserve(50);
  
  // Confirmação de boot
  Serial.println("SAFENAP_READY");
}

void loop() {
  if (stringComplete) {
    inputString.trim(); // Remove \n \r
    
    if (inputString == "ALARM_ON") {
      digitalWrite(PIN_BUZZER, HIGH);
      digitalWrite(PIN_VIBRATION, HIGH);
      digitalWrite(PIN_LED, HIGH);
      Serial.println("OK:ALARM_ON");
    } 
    else if (inputString == "ALARM_OFF") {
      digitalWrite(PIN_BUZZER, LOW);
      digitalWrite(PIN_VIBRATION, LOW);
      digitalWrite(PIN_LED, LOW);
      Serial.println("OK:ALARM_OFF");
    }
    else if (inputString == "VIBRATION_ON") {
      digitalWrite(PIN_VIBRATION, HIGH);
      digitalWrite(PIN_LED, HIGH);
      Serial.println("OK:VIBRATION_ON");
    }
    else if (inputString == "VIBRATION_OFF") {
      digitalWrite(PIN_VIBRATION, LOW);
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
