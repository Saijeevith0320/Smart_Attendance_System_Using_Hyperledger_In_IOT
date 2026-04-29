const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const crypto   = require('crypto');
const ejs      = require('ejs');
const puppeteer = require('puppeteer-core');
require('dotenv').config();

// ── Try to load Fabric dependencies (optional) ────────────────
let grpc, fabricGateway;
try {
    grpc           = require('@grpc/grpc-js');
    fabricGateway  = require('@hyperledger/fabric-gateway');
} catch (_) {
    console.warn('[Fabric] SDK not installed — running in local-only mode.');
}
const fs = require('fs/promises');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ── Fabric config ─────────────────────────────────────────────
const channelName   = process.env.CHANNEL_NAME   || 'mychannel';
const chaincodeName = process.env.CHAINCODE_NAME || 'attendance';
const mspId         = process.env.MSP_ID         || 'Org1MSP';

const cryptoPath = process.env.CRYPTO_PATH || path.resolve(
    __dirname, '..', 'fabric-scripts', 'fabric-samples', 'test-network',
    'organizations', 'peerOrganizations', 'org1.example.com'
);
const keyDirectoryPath = path.resolve(cryptoPath, 'users', 'User1@org1.example.com', 'msp', 'keystore');
const certPath         = path.resolve(cryptoPath, 'users', 'User1@org1.example.com', 'msp', 'signcerts', 'User1@org1.example.com-cert.pem');
const tlsCertPath      = path.resolve(cryptoPath, 'peers', 'peer0.org1.example.com', 'tls', 'ca.crt');
const peerEndpoint     = process.env.PEER_ENDPOINT   || 'localhost:7051';
const peerHostAlias    = process.env.PEER_HOST_ALIAS || 'peer0.org1.example.com';

let gateway;
let contract;
let fabricReady = false;

// ── In-memory fallback store (used when Fabric is not running) ─
// Records are stored here so Arduino scans still work end-to-end.
const localStore = [];

// ── Fabric Connection ─────────────────────────────────────────
async function initFabric() {
    if (!grpc || !fabricGateway) {
        console.log('[Fabric] SDK missing — skipping Fabric init. Using local store.');
        return;
    }
    try {
        console.log('[Fabric] Initializing connection...');
        const tlsRootCert   = await fs.readFile(tlsCertPath);
        const certificate   = await fs.readFile(certPath);
        const files         = await fs.readdir(keyDirectoryPath);
        const keyPath       = path.resolve(keyDirectoryPath, files[0]);
        const privateKeyPem = await fs.readFile(keyPath);
        const privateKey    = crypto.createPrivateKey(privateKeyPem);

        const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
        const client = new grpc.Client(peerEndpoint, tlsCredentials, {
            'grpc.ssl_target_name_override': peerHostAlias,
        });

        gateway = fabricGateway.connect({
            client,
            identity : { mspId, credentials: certificate },
            signer   : fabricGateway.signers.newPrivateKeySigner(privateKey),
            evaluateOptions     : () => ({ deadline: Date.now() + 5000  }),
            endorseOptions      : () => ({ deadline: Date.now() + 15000 }),
            submitOptions       : () => ({ deadline: Date.now() + 5000  }),
            commitStatusOptions : () => ({ deadline: Date.now() + 60000 }),
        });

        const network = gateway.getNetwork(channelName);
        contract      = network.getContract(chaincodeName);
        fabricReady   = true;
        console.log('[Fabric] ✅ Connected successfully.');
    } catch (error) {
        fabricReady = false;
        console.warn('[Fabric] ⚠️  Could not connect:', error.message);
        console.log('[Fabric] Falling back to local in-memory store.');
    }
}

// ── Serve frontend statically ─────────────────────────────────
const frontendPath = path.resolve(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

// ── Health Check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        status      : 'ok',   // always ok — we always have local fallback
        fabricReady,
        mode        : fabricReady ? 'hyperledger-fabric' : 'local-store',
        recordCount : localStore.length,
        uptime      : process.uptime(),
        timestamp   : new Date().toISOString()
    });
});

// ── POST /api/attendance — IoT device submits a scan ──────────
app.post('/api/attendance', async (req, res) => {
    const { studentHash, name, status } = req.body;

    if (!studentHash) {
        return res.status(400).json({ error: 'studentHash is required.' });
    }

    const timestamp = new Date().toISOString();
    const recordId  = `ATT_${Date.now()}_${studentHash.substring(0, 8)}`;

    const record = {
        docType     : 'attendance',
        studentHash : studentHash.trim(),
        studentName : (name   || 'Unknown').trim(),
        status      : (status || 'Unknown').trim(),
        timestamp
    };

    // ── Try Fabric first ────────────────────────────────────
    if (fabricReady && contract) {
        try {
            console.log(`[Fabric] Submitting — ${record.studentName} | ${record.status}`);
            const resultBytes = await contract.submitTransaction(
                'MarkAttendance', record.studentHash, record.studentName, record.status
            );
            const result = JSON.parse(new TextDecoder().decode(resultBytes));
            // Mirror to local store so frontend always has data
            localStore.unshift({ Key: result.recordId || recordId, Record: { ...record } });
            return res.json({ success: true, transactionResult: result, mode: 'fabric' });
        } catch (err) {
            console.error('[Fabric] Submit failed, falling back to local store:', err.message);
        }
    }

    // ── Fallback: local in-memory store ─────────────────────
    console.log(`[Local] Storing — ${record.studentName} | ${record.status}`);
    localStore.unshift({ Key: recordId, Record: record });
    res.json({
        success           : true,
        transactionResult : { recordId, ...record },
        mode              : 'local-store',
        message           : 'Stored locally (Fabric not connected). Run network_setup.sh to enable blockchain.'
    });
});

// ── GET /api/attendance — Dashboard fetches all records ────────
app.get('/api/attendance', async (req, res) => {
    // ── Try Fabric ──────────────────────────────────────────
    if (fabricReady && contract) {
        try {
            const resultBytes = await contract.evaluateTransaction('GetAllRecords');
            const fabricRecords = JSON.parse(new TextDecoder().decode(resultBytes));
            // Merge fabric records with any local-only records
            const allKeys = new Set(fabricRecords.map(r => r.Key));
            const extra   = localStore.filter(r => !allKeys.has(r.Key));
            const merged  = [...extra, ...fabricRecords].sort(
                (a, b) => new Date(b.Record.timestamp) - new Date(a.Record.timestamp)
            );
            return res.json({ success: true, records: merged, mode: 'fabric' });
        } catch (err) {
            console.error('[Fabric] Query failed, returning local store:', err.message);
        }
    }

    // ── Fallback: local store ────────────────────────────────
    const sorted = [...localStore].sort(
        (a, b) => new Date(b.Record.timestamp) - new Date(a.Record.timestamp)
    );
    res.json({ success: true, records: sorted, mode: 'local-store' });
});

// ── GET /api/attendance/summary ────────────────────────────────
app.get('/api/attendance/summary', async (req, res) => {
    const { records } = await getRecordsLocal();
    const summary = {};
    for (const item of records) {
        const key = item.Record.studentHash;
        if (!summary[key]) {
            summary[key] = { studentHash: item.Record.studentHash, studentName: item.Record.studentName, count: 0, lastSeen: '' };
        }
        summary[key].count++;
        if (!summary[key].lastSeen || item.Record.timestamp > summary[key].lastSeen) {
            summary[key].lastSeen = item.Record.timestamp;
        }
    }
    res.json({ success: true, summary: Object.values(summary).sort((a, b) => b.count - a.count) });
});

// ── GET /api/attendance/:studentId ─────────────────────────────
app.get('/api/attendance/:studentId', async (req, res) => {
    const { records } = await getRecordsLocal();
    const query = req.params.studentId.toLowerCase();
    const filtered = records.filter(r => 
        (r.Record.studentName && r.Record.studentName.toLowerCase().includes(query)) ||
        (r.Record.studentHash && r.Record.studentHash === req.params.studentId)
    );
    res.json({ success: true, records: filtered });
});

// ── Helper ────────────────────────────────────────────────────
async function getRecordsLocal() {
    if (fabricReady && contract) {
        try {
            const bytes   = await contract.evaluateTransaction('GetAllRecords');
            const fabricRecords = JSON.parse(new TextDecoder().decode(bytes));
            const allKeys = new Set(fabricRecords.map(r => r.Key));
            const extra   = localStore.filter(r => !allKeys.has(r.Key));
            const merged  = [...extra, ...fabricRecords].sort(
                (a, b) => new Date(b.Record.timestamp) - new Date(a.Record.timestamp)
            );
            return { records: merged };
        } catch (_) {}
    }
    const sorted = [...localStore].sort(
        (a, b) => new Date(b.Record.timestamp) - new Date(a.Record.timestamp)
    );
    return { records: sorted };
}

// ── PDF Generation Endpoints ────────────────────────────────────
app.post('/api/export/pdf/full', async (req, res) => {
    try {
        const { records } = await getRecordsLocal();
        const html = await ejs.renderFile(path.join(__dirname, 'templates', 'report_full.ejs'), { records });
        
        const browser = await puppeteer.launch({
            executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' } });
        await browser.close();

        res.contentType("application/pdf");
        res.send(Buffer.from(pdf));
    } catch (err) {
        console.error('PDF Generation Error:', err);
        res.status(500).json({ error: 'Failed to generate PDF' });
    }
});

app.post('/api/export/pdf/student/:studentId', async (req, res) => {
    try {
        const { records } = await getRecordsLocal();
        const query = req.params.studentId.toLowerCase();
        const filtered = records.filter(r => 
            (r.Record.studentName && r.Record.studentName.toLowerCase().includes(query)) ||
            (r.Record.studentHash && r.Record.studentHash === req.params.studentId)
        );

        if (filtered.length === 0) {
            return res.status(404).json({ error: 'Student not found' });
        }

        const studentName = filtered[0].Record.studentName || 'Unknown';
        const studentHash = filtered[0].Record.studentHash || 'Unknown';
        const totalScans = filtered.length;
        const granted = filtered.filter(r => r.Record.status === 'Access Granted').length;
        const denied = totalScans - granted;

        const html = await ejs.renderFile(path.join(__dirname, 'templates', 'report_student.ejs'), { 
            records: filtered, studentName, studentHash, totalScans, granted, denied 
        });

        const browser = await puppeteer.launch({
            executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setContent(html);
        await page.waitForSelector('.chart-ready'); // Wait for Chart.js
        const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' } });
        await browser.close();

        res.contentType("application/pdf");
        res.send(Buffer.from(pdf));
    } catch (err) {
        console.error('PDF Generation Error:', err);
        res.status(500).json({ error: 'Failed to generate PDF' });
    }
});

// ── Catch-all: serve frontend for any non-API route ───────────
app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────
initFabric().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n╔══════════════════════════════════════════════╗`);
        console.log(`║  Smart Bench Backend Gateway                 ║`);
        console.log(`║  Backend running on http://0.0.0.0:${PORT}          ║`);
        console.log(`║  API: http://0.0.0.0:${PORT}/api/attendance         ║`);
        console.log(`║  Fabric: ${fabricReady ? '✅ Connected' : '⚠️  Local-store mode'}              ║`);
        console.log(`╚══════════════════════════════════════════════╝\n`);
    });
});
