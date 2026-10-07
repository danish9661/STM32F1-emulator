/*
 * I2C JS-only-slave repro: pointer write + repeated START + read-N.
 *
 * There is NO engine-internal slave at 0x68. The host implements the device
 * entirely in JS (STM32F1.i2c1 onStart/onWrite/onRead + injectRx), which is
 * how the live page's I2C slave card and the MPU6050 virtual sensor work.
 *
 * This exercises exactly the two master-receiver shapes the STM32duino Wire
 * layer produces after a pointer write with endTransmission(false):
 *
 *   requestFrom(0x68, 1)   single byte  -- regression target
 *   requestFrom(0x68, 6)   six-byte burst -- already worked
 *
 * Both are pointer writes (no STOP between write and read), so the bus sees:
 *
 *   START  addr(0x68,W)  0x75   repeated-START  addr(0x68,R)  <N bytes>  STOP
 *
 * One PASS/FAIL line per case on USART1, then DONE, so the harness asserts on
 * exact strings. No ext_devices / add_i2c_eeprom: keeping the address unmapped
 * in the engine is what forces the virtual_claim path under test.
 */

#include <Wire.h>

static void readCase(const char *name, uint8_t reg, uint8_t want)
{
    /* Pointer write, no STOP: the read below is a repeated START. */
    Wire.beginTransmission(0x68);
    Wire.write(reg);
    Wire.endTransmission(false);

    Wire.requestFrom((uint8_t)0x68, (uint8_t)want);

    uint8_t n = Wire.available();
    Serial.print(name);
    Serial.print(" n=");
    Serial.print(n);
    Serial.print(" b=");
    /* Hex so the harness can compare the exact bytes the host queued. */
    for (uint8_t i = 0; i < n; i++) {
        uint8_t v = Wire.read();
        Serial.print((v >> 4) ? "0" : "");
        Serial.print(v, HEX);
        if (i + 1 < n) Serial.print(' ');
    }
    Serial.println();
}

void setup()
{
    Serial.begin(115200);
    Wire.begin();

    readCase("READ1", 0x75, 1);
    readCase("READ6", 0x3B, 6);

    Serial.println("DONE");
}

void loop()
{
}
