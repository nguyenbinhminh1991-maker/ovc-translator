'use strict';

/**
 * OVC Translator — Proxy Server
 *
 * - Azure AD OAuth2: only accounts from your tenant can log in
 * - Serves the static frontend from ./src  (protected — login required)
 * - Proxies /api/transcribe WebSocket → Soniox (auth checked on upgrade)
 */

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path       = require('path');
const session    = require('express-session');
const msal       = require('@azure/msal-node');

// ─── Config validation ────────────────────────────────────────────────────────

const required = ['SONIOX_API_KEY', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID', 'AZURE_REDIRECT_URI', 'AZURE_ALLOWED_GROUP_ID'];
for (const key of required) {
    if (!process.env[key]) { console.error(`❌  ${key} is not set`); process.exit(1); }
}

const PORT           = process.env.PORT || 3000;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;
const SONIOX_URL     = 'wss://stt-rt.soniox.com/transcribe-websocket';
const TENANT_ID      = process.env.AZURE_TENANT_ID;
const REDIRECT_URI   = process.env.AZURE_REDIRECT_URI;

// ─── MSAL (Azure AD) ──────────────────────────────────────────────────────────

const pca = new msal.ConfidentialClientApplication({
    auth: {
        clientId:     process.env.AZURE_CLIENT_ID,
        authority:    `https://login.microsoftonline.com/${TENANT_ID}`,
        clientSecret: process.env.AZURE_CLIENT_SECRET,
    },
});

// ─── Express ──────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

// Render (and most hosts) sit behind a reverse proxy — needed for secure cookies
app.set('trust proxy', 1);

// ─── Session ──────────────────────────────────────────────────────────────────

if (!process.env.SESSION_SECRET) {
    console.warn('⚠️   SESSION_SECRET not set — sessions will not survive restarts. Set it in Render env vars.');
}

const sessionMiddleware = session({
    secret:            process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
    resave:            false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        maxAge:   8 * 60 * 60 * 1000, // 8 hours
    },
});

app.use(sessionMiddleware);

// ─── Group membership check (Microsoft Graph) ────────────────────────────────
//
// Uses app-level client-credentials token so the user is never prompted for
// extra consent.  Requires "GroupMember.Read.All" Application permission on the
// App Registration with admin consent granted.

async function checkGroupMembership(userOid) {
    // Acquire an app token for Graph (MSAL caches it until expiry)
    const tokenResult = await pca.acquireTokenByClientCredential({
        scopes: ['https://graph.microsoft.com/.default'],
    });

    const response = await fetch(
        `https://graph.microsoft.com/v1.0/users/${userOid}/checkMemberGroups`,
        {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${tokenResult.accessToken}`,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({ groupIds: [process.env.AZURE_ALLOWED_GROUP_ID] }),
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Graph API ${response.status}: ${text}`);
    }

    const data = await response.json();
    // Returns the subset of requested IDs the user actually belongs to
    return Array.isArray(data.value) && data.value.includes(process.env.AZURE_ALLOWED_GROUP_ID);
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    req.session.returnTo = req.originalUrl;
    res.redirect('/auth/login');
}

// Parse the session cookie for WebSocket upgrade requests (no real res needed)
function parseSessionForWs(req, callback) {
    const fakeRes = {
        on:           () => fakeRes,
        getHeader:    () => undefined,
        setHeader:    () => fakeRes,
        removeHeader: () => {},
    };
    sessionMiddleware(req, fakeRes, callback);
}

// ─── Auth routes (public — no requireAuth) ────────────────────────────────────

app.get('/auth/login', async (req, res) => {
    try {
        const url = await pca.getAuthCodeUrl({
            scopes:      ['openid', 'profile', 'email'],
            redirectUri: REDIRECT_URI,
        });
        res.redirect(url);
    } catch (err) {
        console.error('[auth] getAuthCodeUrl:', err.message);
        res.status(500).send('Failed to start login. Please try again.');
    }
});

app.get('/auth/callback', async (req, res) => {
    if (req.query.error) {
        return res.status(401).send(`Login failed: ${req.query.error_description || req.query.error}`);
    }

    // ── Step 1: exchange the auth code for tokens ─────────────────────────────
    let result;
    try {
        result = await pca.acquireTokenByCode({
            code:        req.query.code,
            scopes:      ['openid', 'profile', 'email'],
            redirectUri: REDIRECT_URI,
        });
    } catch (err) {
        console.error('[auth] acquireTokenByCode:', err.message);
        return res.status(500).send('Authentication failed — could not exchange token. Please try again.');
    }

    // ── Step 2: confirm the account belongs to the configured tenant ──────────
    if (result.tenantId !== TENANT_ID) {
        return res.status(403).send('Access denied: your account is not from the authorized organization.');
    }

    // ── Step 3: confirm the account is in the allowed security group ──────────
    const userOid = result.idTokenClaims?.oid;
    if (!userOid) {
        return res.status(500).send('Authentication error: could not determine user identity.');
    }

    let isMember;
    try {
        isMember = await checkGroupMembership(userOid);
    } catch (err) {
        console.error('[auth] checkGroupMembership:', err.message);
        return res.status(500).send(
            'Authentication error: could not verify group membership. ' +
            'Ensure the app has GroupMember.Read.All application permission with admin consent.'
        );
    }

    if (!isMember) {
        return res.status(403).send(
            'Access denied: your account is not in the authorised group. ' +
            'Contact your administrator to request access.'
        );
    }

    // ── Step 4: create session ────────────────────────────────────────────────
    req.session.user = {
        name:     result.account.name,
        username: result.account.username,
    };

    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    res.redirect(returnTo);
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    const base = REDIRECT_URI.replace('/auth/callback', '');
    res.redirect(
        `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/logout` +
        `?post_logout_redirect_uri=${encodeURIComponent(base)}`
    );
});

// ─── Protected static files ───────────────────────────────────────────────────

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'src')));

// ─── WebSocket proxy (/api/transcribe) ────────────────────────────────────────
// noServer=true so we can auth the upgrade before handing off to wss

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/api/transcribe') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
    }

    parseSessionForWs(req, () => {
        if (!req.session?.user) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    });
});

wss.on('connection', (browserWs, req) => {
    const who = req.session?.user?.username || req.socket.remoteAddress;
    console.log(`[proxy] connected  ${who}`);

    let sonioxWs  = null;
    const pending = [];

    browserWs.on('message', (data, isBinary) => {

        if (!sonioxWs) {
            if (isBinary) { console.warn('[proxy] binary before config — dropping'); return; }

            let config;
            try { config = JSON.parse(data.toString()); }
            catch { browserWs.close(1008, 'Invalid JSON config'); return; }

            config.api_key = SONIOX_API_KEY;
            sonioxWs = new WebSocket(SONIOX_URL);

            sonioxWs.on('open', () => {
                sonioxWs.send(JSON.stringify(config));
                for (const chunk of pending)
                    if (sonioxWs.readyState === WebSocket.OPEN)
                        sonioxWs.send(chunk, { binary: true });
                pending.length = 0;
            });
            sonioxWs.on('message', (msg, bin) => {
                if (browserWs.readyState === WebSocket.OPEN) browserWs.send(msg, { binary: bin });
            });
            sonioxWs.on('close',  (code, reason) => {
                if (browserWs.readyState === WebSocket.OPEN) browserWs.close(code, reason);
            });
            sonioxWs.on('error', err => {
                console.error('[proxy] Soniox error:', err.message);
                if (browserWs.readyState === WebSocket.OPEN) browserWs.close(1011, 'Upstream error');
            });
            return;
        }

        if (sonioxWs.readyState === WebSocket.OPEN)
            sonioxWs.send(data, { binary: isBinary });
        else if (sonioxWs.readyState === WebSocket.CONNECTING && isBinary)
            pending.push(data);
    });

    browserWs.on('close', code => {
        console.log(`[proxy] disconnected  ${who}  code=${code}`);
        if (sonioxWs && sonioxWs.readyState !== WebSocket.CLOSED) sonioxWs.close(1000);
    });
    browserWs.on('error', err => {
        console.error('[proxy] browser WS error:', err.message);
        if (sonioxWs && sonioxWs.readyState !== WebSocket.CLOSED) sonioxWs.terminate();
    });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => console.log(`✅  OVC Translator → http://localhost:${PORT}`));
