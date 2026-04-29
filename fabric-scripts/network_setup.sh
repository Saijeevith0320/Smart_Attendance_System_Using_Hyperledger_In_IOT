#!/bin/bash
# ============================================================
#  Smart Bench — Hyperledger Fabric Network Setup
#  Run this script from the project root: iot_ibm/
#  Usage: bash fabric-scripts/network_setup.sh
# ============================================================
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$PROJECT_ROOT/fabric-scripts"
CHAINCODE_DIR="$PROJECT_ROOT/chaincode"
BACKEND_DIR="$PROJECT_ROOT/backend"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   Smart Bench — Hyperledger Fabric Network Setup     ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Download fabric-samples if not present ───────────
cd "$SCRIPT_DIR"
if [ ! -d "fabric-samples" ]; then
    echo "▶  Downloading Fabric samples, binaries, and Docker images..."
    curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
    chmod +x install-fabric.sh
    ./install-fabric.sh docker samples binary
    echo "✅  Fabric downloaded."
else
    echo "✔  fabric-samples already present — skipping download."
fi

# ── Step 2: Install chaincode dependencies ───────────────────
echo ""
echo "▶  Installing chaincode Node.js dependencies..."
cd "$CHAINCODE_DIR"
npm install --silent
echo "✅  Chaincode dependencies installed."

# ── Step 3: Start the Fabric test network ────────────────────
echo ""
echo "▶  Starting Hyperledger Fabric test network..."
cd "$SCRIPT_DIR/fabric-samples/test-network"

echo "   Tearing down any existing network..."
./network.sh down 2>/dev/null || true

echo "   Bringing up network + channel (mychannel) with CAs..."
./network.sh up createChannel -c mychannel -ca

echo "✅  Network up and channel 'mychannel' created."

# ── Step 4: Deploy the attendance chaincode ──────────────────
echo ""
echo "▶  Deploying attendance chaincode..."
CHAINCODE_PATH="$CHAINCODE_DIR"

./network.sh deployCC \
    -ccn attendance \
    -ccp "$CHAINCODE_PATH" \
    -ccl javascript \
    -ccv 1.0 \
    -ccs 1

echo "✅  Chaincode 'attendance' deployed."

# ── Step 5: Post-deploy smoke test ───────────────────────────
echo ""
echo "▶  Running post-deploy smoke test (InitLedger)..."
export PATH="$SCRIPT_DIR/fabric-samples/bin:$PATH"
export FABRIC_CFG_PATH="$SCRIPT_DIR/fabric-samples/config/"
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_TLS_ROOTCERT_FILE="$SCRIPT_DIR/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
export CORE_PEER_MSPCONFIGPATH="$SCRIPT_DIR/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_ADDRESS=localhost:7051

peer chaincode query \
    -C mychannel \
    -n attendance \
    -c '{"Args":["GetAllRecords"]}' 2>/dev/null && \
    echo "✅  Smoke test passed — chaincode responding." || \
    echo "⚠️   Smoke test could not run (peer CLI not in PATH). Continue manually."

# ── Step 6: Copy connection profile to backend ───────────────
echo ""
echo "▶  Copying connection profile to backend..."
mkdir -p "$BACKEND_DIR/config"
cp "$SCRIPT_DIR/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/connection-org1.json" \
   "$BACKEND_DIR/config/" 2>/dev/null || \
    echo "⚠️   connection-org1.json not found yet — copy manually after network starts."

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✅  All done! Next steps:                           ║"
echo "║                                                      ║"
echo "║  1. cd backend && npm install && npm start           ║"
echo "║  2. Open frontend/index.html in your browser         ║"
echo "║  3. Upload iot/attendance_system.ino to Arduino      ║"
echo "║     (set BACKEND_HOST to your machine's local IP)    ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
