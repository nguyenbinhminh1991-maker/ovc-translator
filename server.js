/**
 * Translator Proxy Server
 *
 * - Serves the static frontend from ./src
 * - Proxies WebSocket connections at /api/transcribe → Soniox
 * - The SONIOX_API_KEY is injected server-side; the browser never sees it
 */

'use strict';

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path       = require('path');

const PORT           = process.env.PORT || 3000;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;
const SONIOX_URL     = 'wss://stt-rt.soniox.com/transcribe-websocket';

if (!SONIOX_API_KEY) {
    console.error('❌  SONIOX_API_KEY is not set. Add it to your .env file.');
    process.exit(1);
}

// ─── HTTP / Static ────────────────────────────────────────────────────────────

const app = express();
app.use(express.static(path.join(__dirname, 'src')));

const server = http.createServer(app);

// ─── WebSocket Proxy ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/api/transcribe' });

wss.on('connection', (browserWs, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`[proxy] client connected  ${clientIP}`);

    let sonioxWs  = null;
    const pending = []; // audio chunks that arrive before Soniox handshake finishes

    // ── Messages from browser ────────────────────────────────────────────────
    browserWs.on('message', (data, isBinary) => {

        // ── First message must be the JSON config ──────────────────────────
        if (!sonioxWs) {
            if (isBinary) {
                console.warn('[proxy] binary received before config — dropping');
                return;
            }

            let config;
            try {
                config = JSON.parse(data.toString());
            } catch {
                browserWs.close(1008, 'Invalid JSON config');
                return;
            }

            // Inject the real key — browser sends none
            config.api_key = SONIOX_API_KEY;

            console.log('[proxy] opening Soniox connection...');
            sonioxWs = new WebSocket(SONIOX_URL);

            sonioxWs.on('open', () => {
                console.log('[proxy] Soniox ready');
                sonioxWs.send(JSON.stringify(config));
                // Flush audio that arrived while the handshake was in progress
                for (const chunk of pending) {
                    if (sonioxWs.readyState === WebSocket.OPEN)
                        sonioxWs.send(chunk, { binary: true });
                }
                pending.length = 0;
            });

            // Relay Soniox → browser
            sonioxWs.on('message', (msg, bin) => {
                if (browserWs.readyState === WebSocket.OPEN)
                    browserWs.send(msg, { binary: bin });
            });

            sonioxWs.on('close', (code, reason) => {
                console.log(`[proxy] Soniox closed  code=${code}`);
                if (browserWs.readyState === WebSocket.OPEN)
                    browserWs.close(code, reason);
            });

            sonioxWs.on('error', err => {
                console.error('[proxy] Soniox error:', err.message);
                if (browserWs.readyState === WebSocket.OPEN)
                    browserWs.close(1011, 'Upstream error');
            });

            return;
        }

        // ── Subsequent messages: audio chunks or keepalive JSON ────────────
        if (sonioxWs.readyState === WebSocket.OPEN) {
            sonioxWs.send(data, { binary: isBinary });
        } else if (sonioxWs.readyState === WebSocket.CONNECTING && isBinary) {
            pending.push(data);     // still connecting — buffer audio
        }
    });

    // ── Browser disconnects ──────────────────────────────────────────────────
    browserWs.on('close', code => {
        console.log(`[proxy] client disconnected  ${clientIP}  code=${code}`);
        if (sonioxWs && sonioxWs.readyState !== WebSocket.CLOSED)
            sonioxWs.close(1000);
    });

    browserWs.on('error', err => {
        console.error('[proxy] browser WS error:', err.message);
        if (sonioxWs && sonioxWs.readyState !== WebSocket.CLOSED)
            sonioxWs.terminate();
    });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    console.log(`✅  Translator running → http://localhost:${PORT}`);
});
