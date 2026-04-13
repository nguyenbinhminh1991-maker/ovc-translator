/**
 * Netlify Edge Function — WebSocket proxy for Soniox
 *
 * Runs on the Deno runtime at Netlify's CDN edge.
 * - Upgrades the browser WebSocket connection
 * - Waits for the first JSON config message from the browser
 * - Injects SONIOX_API_KEY (from Netlify env) before forwarding to Soniox
 * - Pipes audio chunks and JSON responses bidirectionally
 * - Buffers audio that arrives before the Soniox handshake completes
 */

const SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';

export default async (request: Request): Promise<Response> => {
    // Only accept WebSocket upgrade requests
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('This endpoint only accepts WebSocket connections.', {
            status: 426,
            headers: { 'Upgrade': 'websocket' },
        });
    }

    const apiKey = Deno.env.get('SONIOX_API_KEY');
    if (!apiKey) {
        console.error('[proxy] SONIOX_API_KEY is not set in Netlify environment variables.');
        return new Response('Server configuration error.', { status: 500 });
    }

    // Upgrade the incoming browser connection
    const { socket: browserSocket, response } = Deno.upgradeWebSocket(request);

    let sonioxSocket: WebSocket | null = null;
    // Buffer binary audio chunks that arrive before Soniox handshake completes
    const pending: ArrayBuffer[] = [];

    browserSocket.onmessage = (event) => {
        // ── First message: JSON config from browser ────────────────────────
        if (!sonioxSocket) {
            if (event.data instanceof ArrayBuffer) {
                console.warn('[proxy] Binary received before config — dropping');
                return;
            }

            let config: Record<string, unknown>;
            try {
                config = JSON.parse(event.data as string);
            } catch {
                browserSocket.close(1008, 'Invalid JSON config');
                return;
            }

            // Inject the real key — browser never sends it
            config.api_key = apiKey;

            console.log('[proxy] Opening Soniox connection...');
            sonioxSocket = new WebSocket(SONIOX_URL);

            sonioxSocket.onopen = () => {
                console.log('[proxy] Soniox ready');
                sonioxSocket!.send(JSON.stringify(config));

                // Flush buffered audio
                for (const chunk of pending) {
                    if (sonioxSocket!.readyState === WebSocket.OPEN) {
                        sonioxSocket!.send(chunk);
                    }
                }
                pending.length = 0;
            };

            // Relay Soniox → browser
            sonioxSocket.onmessage = (e) => {
                if (browserSocket.readyState === WebSocket.OPEN) {
                    browserSocket.send(e.data);
                }
            };

            sonioxSocket.onclose = (e) => {
                console.log(`[proxy] Soniox closed  code=${e.code}`);
                if (browserSocket.readyState === WebSocket.OPEN) {
                    browserSocket.close(e.code, e.reason);
                }
            };

            sonioxSocket.onerror = (e) => {
                console.error('[proxy] Soniox error:', e);
                if (browserSocket.readyState === WebSocket.OPEN) {
                    browserSocket.close(1011, 'Upstream error');
                }
            };

            return;
        }

        // ── Subsequent messages: audio chunks or keepalive JSON ────────────
        if (sonioxSocket.readyState === WebSocket.OPEN) {
            sonioxSocket.send(event.data);
        } else if (sonioxSocket.readyState === WebSocket.CONNECTING &&
                   event.data instanceof ArrayBuffer) {
            pending.push(event.data);
        }
    };

    // ── Browser disconnects ────────────────────────────────────────────────
    browserSocket.onclose = (e) => {
        console.log(`[proxy] Browser disconnected  code=${e.code}`);
        if (sonioxSocket && sonioxSocket.readyState !== WebSocket.CLOSED) {
            sonioxSocket.close(1000);
        }
    };

    browserSocket.onerror = (e) => {
        console.error('[proxy] Browser WS error:', e);
        if (sonioxSocket && sonioxSocket.readyState !== WebSocket.CLOSED) {
            sonioxSocket.close();
        }
    };

    return response;
};

export const config = { path: '/api/transcribe' };
