
/*
 * ============================================================
 *  Smart Bench — RFID Attendance System
 *  Board   : Arduino UNO R4 WiFi
 *  Backend : Hyperledger Fabric Gateway (Node.js, port 3001)
 * ============================================================
 */

#include <LiquidCrystal_I2C.h>
#include <MFRC522.h>
#include <SPI.h>
#include <WiFiS3.h>
#include <Wire.h>

// LCD
LiquidCrystal_I2C lcd(0x27, 16, 2);

// RFID
#define SS_PIN 10
#define RST_PIN 9
MFRC522 rfid(SS_PIN, RST_PIN);

// Output Pins
#define GREEN_LED 6
#define RED_LED 7
#define BUZZER 8

// Wi-Fi
const char *WIFI_SSID = "Nirmal grorge";
const char *WIFI_PASSWORD = "123456789";

// Backend
const char *BACKEND_HOST = "192.168.29.127";
const int BACKEND_PORT = 3001;
const char *BACKEND_PATH = "/api/attendance";

// Users
struct User {
  byte uid[4];
  String name;
};

User authorizedUsers[] = {
    {{0x4F, 0x58, 0x0B, 0x2E}, "G.Sai Jeevith"},
    {{0xCF, 0xD6, 0x6C, 0x2E}, "Navami Manesh"},
    {{0x0F, 0xB2, 0x9F, 0x2E}, "Souparnika P S"},
    {{0xCF, 0xF9, 0x00, 0x2E}, "Pavan Kumar N"},
    {{0xC2, 0x9D, 0x16, 0x1B}, "Palakuri Manoj Kumar | ID:30066"}};

const int USER_COUNT = sizeof(authorizedUsers) / sizeof(User);

// ─── SHA256 Simplified Placeholder ─────────────────────────
// NOTE: Replace with your previously working full SHA256 implementation if
// needed
String computeSHA256(String input) {
  // Simple fallback hash-like output for testing
  String hash = "";
  for (unsigned int i = 0; i < input.length(); i++) {
    hash += String((int)input[i], HEX);
  }

  while (hash.length() < 64) {
    hash += "0";
  }

  return hash.substring(0, 64);
}

// ─── Helpers ───────────────────────────────────────────────
bool compareUID(byte *a, byte *b) {
  for (byte i = 0; i < 4; i++) {
    if (a[i] != b[i])
      return false;
  }
  return true;
}

String getUIDString(byte *uid) {
  String s = "";
  for (byte i = 0; i < 4; i++) {
    if (uid[i] < 0x10)
      s += "0";
    s += String(uid[i], HEX);
  }
  s.toUpperCase();
  return s;
}

String jsonEscape(String s) {
  String out = "";
  for (unsigned int i = 0; i < s.length(); i++) {
    char c = s.charAt(i);
    if (c == '"')
      out += "\\\"";
    else if (c == '\\')
      out += "\\\\";
    else
      out += c;
  }
  return out;
}

// ─── Send to Hyperledger Backend ───────────────────────────
void postToFabric(String hash, String name, String status) {
  WiFiClient client;

  Serial.println("Connecting to backend...");

  if (!client.connect(BACKEND_HOST, BACKEND_PORT)) {
    Serial.println("Backend connection failed");
    return;
  }

  String body = "{\"studentHash\":\"" + hash + "\",\"name\":\"" +
                jsonEscape(name) + "\",\"status\":\"" + jsonEscape(status) +
                "\"}";

  client.println("POST " + String(BACKEND_PATH) + " HTTP/1.0");
  client.println("Host: " + String(BACKEND_HOST));
  client.println("Content-Type: application/json");
  client.println("Content-Length: " + String(body.length()));
  client.println("Connection: close");
  client.println();
  client.print(body);

  delay(500);

  while (client.available()) {
    Serial.write(client.read());
  }

  client.stop();

  Serial.println("Attendance sent to Hyperledger");
}

// ─── Setup ─────────────────────────────────────────────────
void setup() {
  Serial.begin(9600);

  SPI.begin();
  rfid.PCD_Init();

  lcd.init();
  lcd.backlight();

  pinMode(GREEN_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(BUZZER, OUTPUT);

  lcd.setCursor(0, 0);
  lcd.print(" Smart Bench ");
  lcd.setCursor(0, 1);
  lcd.print(" Blockchain ");
  delay(1500);

  lcd.clear();
  lcd.print("Joining WiFi");

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  lcd.clear();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi Connected");
    lcd.print("WiFi Connected");
    delay(2000);
  } else {
    Serial.println("\nWiFi Failed");
    lcd.print("WiFi Failed");
    delay(2000);
  }

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(" Smart Bench ");
  lcd.setCursor(0, 1);
  lcd.print("Scan Your Card");
}

// ─── Main Loop ─────────────────────────────────────────────
void loop() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial())
    return;

  byte scannedUID[4];

  for (byte i = 0; i < 4; i++) {
    scannedUID[i] = rfid.uid.uidByte[i];
  }

  String uidString = getUIDString(scannedUID);

  Serial.print("Scanned UID: ");
  Serial.println(uidString);

  String userName = "Unknown";
  String statusText = "Access Denied";
  bool authorized = false;

  for (int i = 0; i < USER_COUNT; i++) {
    if (compareUID(scannedUID, authorizedUsers[i].uid)) {
      authorized = true;
      userName = authorizedUsers[i].name;
      statusText = "Access Granted";
      break;
    }
  }

  String hash = computeSHA256(uidString);

  Serial.print("Hash: ");
  Serial.println(hash);

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(userName.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(authorized ? "Sending..." : "Denied...");

  tone(BUZZER, authorized ? 1000 : 300);
  delay(300);
  noTone(BUZZER);

  if (authorized && WiFi.status() == WL_CONNECTED) {
    postToFabric(hash, userName, statusText);

    digitalWrite(GREEN_LED, HIGH);
    delay(500);
    digitalWrite(GREEN_LED, LOW);
  } else {
    digitalWrite(RED_LED, HIGH);
    delay(500);
    digitalWrite(RED_LED, LOW);
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();

  delay(2000);

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(" Smart Bench ");
  lcd.setCursor(0, 1);
  lcd.print("Scan Your Card");
}
