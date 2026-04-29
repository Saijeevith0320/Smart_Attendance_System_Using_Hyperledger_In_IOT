# Smart_Attendance_System_Using_Hyperledger_In_IOT

> **Arduino UNO R4 WiFi · Hyperledger Fabric · Node.js · Vanilla JS**

A tamper-proof student attendance system: RFID cards are scanned, the UID is **SHA-256 hashed on-device**, and the hash is committed to a **Hyperledger Fabric permissioned blockchain** via a Node.js gateway. A premium web dashboard displays all ledger records in real time.

---

## Architecture

```
┌─────────────────────────────┐
│   Arduino UNO R4 WiFi       │
│   + MFRC522 RFID Reader     │
│   + LCD 16x2 I2C            │
│   + Green/Red LED + Buzzer  │
│                             │
│  1. Read Card UID           │
│  2. Lookup name + status    │
│  3. SHA-256(UID) on-device  │
│  4. HTTP POST → Backend     │
└──────────────┬──────────────┘
               │ POST /api/attendance
               │ { studentHash, name, status }
               ▼
┌─────────────────────────────┐
│   Node.js Backend Gateway   │
│   Express · Fabric SDK      │
│   Port 3001                 │
│                             │
│  5. Validate input          │
│  6. Connect via gRPC        │
│  7. Submit transaction      │
└──────────────┬──────────────┘
               │ gRPC (port 7051)
               ▼
┌─────────────────────────────┐
│  Hyperledger Fabric Network │
│  Docker test-network        │
│  Channel: mychannel         │
│  Chaincode: attendance      │
│                             │
│  8. Endorse + Order         │
│  9. Commit to ledger        │
└─────────────────────────────┘
               ▲
               │ GET /api/attendance
┌─────────────────────────────┐
│   Frontend Dashboard        │
│   frontend/index.html       │
│   Dark glassmorphism UI     │
│   Auto-refresh every 15s    │
└─────────────────────────────┘
```

```

---

## 🌟 Dashboard Features

- **Real-Time Updates**: Auto-polls the backend for new blockchain blocks every 15 seconds.
- **Instant Search**: Live filtering by Campus ID or Student Name with dynamic stat recalculation.
- **Premium PDF Reports**: 
  - **Full Ledger Export**: Generates a presentation-ready PDF of the entire immutable ledger.
  - **Student Profiles**: Generates a personalized student attendance report with an embedded Doughnut Chart visualizing their history.
- **CSV Support**: Lightweight spreadsheet exports for data parsing.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Docker Desktop | 4.x+ | Must be **running** before setup |
| Node.js | 18+ | For backend gateway |
| npm | 9+ | Bundled with Node.js |
| Arduino IDE | 2.x | With **UNO R4 WiFi** board package |

### Required Arduino Libraries (install via Library Manager)
- `MFRC522` by GithubCommunity
- `LiquidCrystal_I2C` by Frank de Brabander
- `WiFiS3` — **built-in** with Arduino UNO R4 WiFi board package

---

## Setup — Step by Step

### 1. Clone and enter the project

```bash
git clone <your-repo-url>
cd iot_ibm
```

### 2. Start Hyperledger Fabric network + deploy chaincode

> Requires Docker Desktop to be running.

```bash
bash fabric-scripts/network_setup.sh
```

This script will:
- Download `fabric-samples` (binaries + Docker images) on first run
- Install chaincode Node.js dependencies
- Spin up the Fabric test-network with Org1, Org2, and an ordering service
- Create channel `mychannel`
- Deploy the `attendance` chaincode
- Copy the connection profile to `backend/config/`

### 3. Install and start the backend gateway

```bash
cd backend
npm install
npm start
```

The gateway will connect to the Fabric peer on `localhost:7051` and expose:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Network status |
| `/api/attendance` | GET | All ledger records |
| `/api/attendance` | POST | Submit new scan (IoT device) |
| `/api/attendance/summary` | GET | Per-student summary |
| `/api/attendance/:hash` | GET | Records for one student |

### 4. Open the dashboard

Simply open `frontend/index.html` in any browser. It will auto-poll the backend every 15 seconds and show toast notifications for new scans.

### 5. Program the Arduino

1. Open `iot/attendance_system/attendance_system.ino` in Arduino IDE 2.x
2. **Edit these two lines:**
   ```cpp
   const char* WIFI_SSID     = "YOUR_WIFI_SSID";
   const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
   const char* BACKEND_HOST  = "192.168.x.x"; // ← your machine's local IP
   ```
   Find your IP: `ifconfig | grep "inet " | grep -v 127` (macOS/Linux)
3. Select **Arduino UNO R4 WiFi** as the board
4. Upload

---

## Wiring Diagram

```
Arduino UNO R4 WiFi
        │
        ├── SPI ──────────────► MFRC522 RFID Reader
        │    SS  → Pin 10
        │    RST → Pin 9
        │    MOSI→ Pin 11
        │    MISO→ Pin 12
        │    SCK → Pin 13
        │
        ├── I2C ──────────────► LCD 16x2 (I2C addr 0x27)
        │    SDA → A4
        │    SCL → A5
        │
        ├── Pin 6  ──────────► Green LED (+220Ω → GND)
        ├── Pin 7  ──────────► Red LED   (+220Ω → GND)
        └── Pin 8  ──────────► Buzzer    (+100Ω → GND)
```

---

## Chaincode API (Smart Contract Functions)

| Function | Args | Description |
|----------|------|-------------|
| `InitLedger` | — | Initialize (called on deploy) |
| `MarkAttendance` | `studentHash, studentName, status` | Record a scan |
| `GetAllRecords` | — | Return all records, newest first |
| `GetRecordsByStudent` | `studentHash` | Filter by student |
| `GetAttendanceSummary` | — | Count + last-seen per student |

---

## Environment Variables (`backend/.env`)

```env
PORT=3001
CHANNEL_NAME=mychannel
CHAINCODE_NAME=attendance
MSP_ID=Org1MSP
PEER_ENDPOINT=localhost:7051
PEER_HOST_ALIAS=peer0.org1.example.com
# Optional override — defaults to fabric-scripts/fabric-samples/test-network path
# CRYPTO_PATH=/absolute/path/to/org1.example.com
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Backend: `ENOENT` on key/cert files | Run `network_setup.sh` first to generate crypto materials |
| Arduino: `Backend Error` on LCD | Check `BACKEND_HOST` is your machine's **local IP** (not `localhost`) |
| Dashboard: "Network Offline" | Ensure `npm start` is running in `backend/` |
| Fabric: `503` from backend | Fabric Docker containers stopped — re-run `network_setup.sh` |
| LCD shows garbage | Check I2C address: run I2C scanner sketch (try `0x27` or `0x3F`) |

---

## Security Notes

- RFID UIDs are **never transmitted in plain text** — only the SHA-256 hash is sent over WiFi and stored on the ledger.
- The Fabric ledger is **append-only** and cryptographically tamper-evident.
- For production, replace the test-network with a proper Fabric network with CA-issued identities and TLS certificates.
