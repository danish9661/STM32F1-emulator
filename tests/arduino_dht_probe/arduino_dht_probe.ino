// DHT22-style bit-bang read on PB0, Adafruit-faithful structure:
// OUTPUT-LOW wake, INPUT_PULLUP release, loop-count expectPulse (no
// absolute timebase — scale-free like the real DHT library), bit = HIGH
// width > LOW width (50us vs 28/70us), checksum verify. Prints DHT_OK /
// DHT_CKSUM / DHT_TIMEOUT on Serial (USART1, PA9/PA10).
#define DPIN PB0

// Width of the current pulse in loop iterations (0 = timeout). Each
// iteration is a few instructions, so counts track sim-time linearly.
static uint32_t pulseCount(bool level) {
  uint32_t count = 0;
  while ((digitalRead(DPIN) ? true : false) == level) {
    if (++count >= 100000) return 0;
  }
  return count;
}

void setup() {
  Serial.begin(9600);
  Serial.println("DHT_READY");
}

void loop() {
  pinMode(DPIN, OUTPUT);
  digitalWrite(DPIN, LOW);
  delay(2);
  digitalWrite(DPIN, HIGH);
  delayMicroseconds(40);
  pinMode(DPIN, INPUT_PULLUP);

  // Adafruit pullTime: let the sensor pull the line low before listening.
  delayMicroseconds(55);

  uint32_t ackLow = pulseCount(LOW);
  uint32_t ackHigh = pulseCount(HIGH);
  uint8_t data[5] = {0, 0, 0, 0, 0};
  bool ok = (ackLow > 0 && ackHigh > 0);
  for (int i = 0; ok && i < 40; i++) {
    uint32_t low = pulseCount(LOW);
    if (!low) { ok = false; break; }
    uint32_t high = pulseCount(HIGH);
    if (!high) { ok = false; break; }
    data[i / 8] <<= 1;
    if (high > low) data[i / 8] |= 1;
  }
  if (ok) {
    uint8_t cks = (uint8_t)(data[0] + data[1] + data[2] + data[3]);
    if (cks == data[4]) {
      float h = (float)((data[0] << 8) | data[1]) / 10.0f;
      float t = (float)(((data[2] & 0x7F) << 8) | data[3]) / 10.0f;
      if (data[2] & 0x80) t = -t;
      Serial.print("DHT_OK T:");
      Serial.print(t);
      Serial.print(" H:");
      Serial.println(h);
    } else {
      Serial.println("DHT_CKSUM");
    }
  } else {
    Serial.println("DHT_TIMEOUT");
  }
  delay(500);
}
