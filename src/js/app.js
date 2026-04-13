/**
 * App — main controller
 * Pure browser app: browser MediaDevices → 16kHz PCM → Soniox → overlay UI
 */

import { settingsManager } from './settings.js';
import { TranscriptUI } from './ui.js';
import { sonioxClient } from './soniox.js';

// ─── PCM AudioWorklet (inline blob) ──────────────────────────────────────────
const PCM_WORKLET_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buf = [];
        this._TARGET = 3200; // 200ms at 16kHz
    }
    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0] || !input[0].length) return true;
        const numChannels = input.length;
        const numSamples = input[0].length;
        for (let i = 0; i < numSamples; i++) {
            let sum = 0;
            for (let ch = 0; ch < numChannels; ch++) sum += input[ch][i];
            this._buf.push(numChannels > 1 ? sum / numChannels : sum);
        }
        while (this._buf.length >= this._TARGET) {
            const chunk = this._buf.splice(0, this._TARGET);
            const pcm = new Int16Array(this._TARGET);
            for (let i = 0; i < this._TARGET; i++) {
                const s = Math.max(-1, Math.min(1, chunk[i]));
                pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            this.port.postMessage(pcm.buffer, [pcm.buffer]);
        }
        return true;
    }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

class App {
    constructor() {
        this.isRunning = false;
        this.isStarting = false;
        this.currentSource = 'system';
        this.transcriptUI = null;

        // Browser audio
        this.audioContext = null;
        this.micStream = null;
        this.sysStream = null;
        this.workletNode = null;
    }

    async init() {
        settingsManager.load();

        const container = document.getElementById('transcript-content');
        this.transcriptUI = new TranscriptUI(container);

        this._applySettings(settingsManager.get());
        this._bindEvents();
        this._bindKeyboardShortcuts();
        settingsManager.onChange(s => this._applySettings(s));

        // Wire Soniox callbacks
        sonioxClient.onOriginal = (text, speaker, language) => {
            this.transcriptUI.addOriginal(text, speaker, language);
        };
        sonioxClient.onTranslation = (text) => {
            this.transcriptUI.addTranslation(text);
        };
        sonioxClient.onProvisional = (text, speaker, language) => {
            text ? this.transcriptUI.setProvisional(text, speaker, language)
                 : this.transcriptUI.clearProvisional();
        };
        sonioxClient.onStatusChange = (status) => this._updateStatus(status);
        sonioxClient.onError = (error) => this._showToast(error, 'error');
        sonioxClient.onConfidence = (c) => this.transcriptUI.setConfidence(c);
    }

    // ─── Events ──────────────────────────────────────────────────────────────

    _bindEvents() {
        document.getElementById('btn-settings').addEventListener('click', () => {
            this._showView('settings');
        });

        document.getElementById('btn-back').addEventListener('click', () => {
            this._showView('overlay');
        });

        document.getElementById('btn-view-mode').addEventListener('click', () => {
            this._toggleViewMode();
        });

        document.getElementById('btn-font-up').addEventListener('click', () => this._adjustFontSize(4));
        document.getElementById('btn-font-down').addEventListener('click', () => this._adjustFontSize(-4));

        document.querySelectorAll('.color-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
                dot.classList.add('active');
                this.transcriptUI.configure({ fontColor: dot.dataset.color });
            });
        });

        document.getElementById('btn-start').addEventListener('click', async () => {
            if (this.isStarting) return;
            try {
                if (this.isRunning) {
                    await this.stop();
                } else {
                    this.isStarting = true;
                    await this.start();
                }
            } catch (err) {
                console.error('[App] Start/Stop error:', err);
                this._showToast(`Error: ${err.message || err}`, 'error');
                this.isRunning = false;
                this._updateStartButton();
                this._updateStatus('error');
                this.transcriptUI.clear();
                this.transcriptUI.showPlaceholder();
            } finally {
                this.isStarting = false;
            }
        });

        document.getElementById('btn-source-system').addEventListener('click', () => this._setSource('system'));
        document.getElementById('btn-source-mic').addEventListener('click', () => this._setSource('microphone'));
        document.getElementById('btn-source-both').addEventListener('click', () => this._setSource('both'));

        document.getElementById('btn-clear').addEventListener('click', () => {
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
        });

        document.getElementById('btn-copy').addEventListener('click', async () => {
            const text = this.transcriptUI.getPlainText();
            if (text) {
                await navigator.clipboard.writeText(text);
                this._showToast('Copied to clipboard', 'success');
            } else {
                this._showToast('Nothing to copy', 'info');
            }
        });

        document.getElementById('btn-save').addEventListener('click', () => {
            const text = this.transcriptUI.getSaveText();
            if (!text) { this._showToast('Nothing to save', 'info'); return; }
            this._download(text, 'text/plain;charset=utf-8', 'transcript', 'txt');
            this._showToast('Saved .txt', 'success');
        });

        document.getElementById('btn-save-csv').addEventListener('click', () => {
            const text = this.transcriptUI.getCSVText();
            if (!text) { this._showToast('Nothing to save', 'info'); return; }
            this._download(text, 'text/csv;charset=utf-8', 'transcript', 'csv');
            this._showToast('Saved .csv', 'success');
        });

        // Settings form
        document.getElementById('btn-save-settings').addEventListener('click', () => this._saveSettingsFromForm());
        document.getElementById('btn-save-settings-top')?.addEventListener('click', () => this._saveSettingsFromForm());

        document.getElementById('range-endpoint-delay')?.addEventListener('input', (e) => {
            document.getElementById('endpoint-delay-value').textContent = `${(e.target.value / 1000).toFixed(1)}s`;
        });

        // Translation type toggle
        document.getElementById('select-translation-type')?.addEventListener('change', (e) => {
            this._updateTranslationTypeUI(e.target.value);
        });

        // Settings tab switching
        document.querySelectorAll('.settings-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab)?.classList.add('active');
            });
        });

        // GitHub links (open in new tab for browser)
        document.getElementById('link-github')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.open('https://github.com/phuc-nt/my-translator', '_blank');
        });
        document.getElementById('link-issues')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.open('https://github.com/phuc-nt/my-translator/issues', '_blank');
        });
    }

    _bindKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if (this.isStarting) return;
                (async () => {
                    try {
                        if (this.isRunning) { await this.stop(); }
                        else { this.isStarting = true; await this.start(); }
                    } catch (err) {
                        this._showToast(`Error: ${err.message || err}`, 'error');
                        this.isRunning = false;
                        this._updateStartButton();
                        this._updateStatus('error');
                    } finally {
                        this.isStarting = false;
                    }
                })();
            }

            if (e.key === 'Escape') {
                e.preventDefault();
                if (document.getElementById('settings-view').classList.contains('active')) {
                    this._showView('overlay');
                }
            }

            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                e.preventDefault();
                this._showView('settings');
            }

            if ((e.metaKey || e.ctrlKey) && e.key === '1') { e.preventDefault(); this._setSource('system'); }
            if ((e.metaKey || e.ctrlKey) && e.key === '2') { e.preventDefault(); this._setSource('microphone'); }
            if ((e.metaKey || e.ctrlKey) && e.key === '3') { e.preventDefault(); this._setSource('both'); }

        });
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    _showView(view) {
        document.getElementById('overlay-view').classList.toggle('active', view === 'overlay');
        document.getElementById('settings-view').classList.toggle('active', view === 'settings');
        if (view === 'settings') this._populateSettingsForm();
    }

    // ─── Settings Form ────────────────────────────────────────────────────────

    _populateSettingsForm() {
        const s = settingsManager.get();

        document.getElementById('select-source-lang').value = s.source_language || 'auto';
        document.getElementById('select-target-lang').value = s.target_language || 'vi';

        const translationType = s.translation_type || 'one_way';
        document.getElementById('select-translation-type').value = translationType;
        this._updateTranslationTypeUI(translationType);

        document.getElementById('select-lang-a').value = s.language_a || 'ja';
        document.getElementById('select-lang-b').value = s.language_b || 'vi';

        document.getElementById('check-strict-lang').checked = s.language_hints_strict || false;

        const endpointDelay = s.endpoint_delay || 3000;
        const delaySlider = document.getElementById('range-endpoint-delay');
        if (delaySlider) delaySlider.value = endpointDelay;
        const delayValue = document.getElementById('endpoint-delay-value');
        if (delayValue) delayValue.textContent = `${(endpointDelay / 1000).toFixed(1)}s`;

        const radioValue = s.audio_source || 'system';
        const radio = document.querySelector(`input[name="audio-source"][value="${radioValue}"]`);
        if (radio) radio.checked = true;

    }

    async _saveSettingsFromForm() {
        const settings = {
            source_language: document.getElementById('select-source-lang').value,
            target_language: document.getElementById('select-target-lang').value,
            translation_type: document.getElementById('select-translation-type')?.value || 'one_way',
            language_a: document.getElementById('select-lang-a')?.value || 'ja',
            language_b: document.getElementById('select-lang-b')?.value || 'vi',
            language_hints_strict: document.getElementById('check-strict-lang')?.checked || false,
            endpoint_delay: parseInt(document.getElementById('range-endpoint-delay')?.value || 3000),
            audio_source: document.querySelector('input[name="audio-source"]:checked')?.value || 'system',
            custom_context: null,
        };


        try {
            settingsManager.save(settings);
            this._showToast('Settings saved', 'success');
            this._showView('overlay');
        } catch (err) {
            this._showToast(`Failed to save: ${err}`, 'error');
        }
    }

    _applySettings(settings) {
        this.currentSource = settings.audio_source || 'system';
        this._updateSourceButtons();
    }

    _updateTranslationTypeUI(type) {
        const oneway = document.getElementById('section-oneway-langs');
        const twoway = document.getElementById('section-twoway-langs');
        const hintTwoway = document.getElementById('hint-twoway');
        const strictLang = document.getElementById('section-strict-lang');

        if (type === 'two_way') {
            if (oneway) oneway.style.display = 'none';
            if (twoway) twoway.style.display = 'flex';
            if (hintTwoway) hintTwoway.style.display = 'block';
            if (strictLang) strictLang.style.display = 'none';
        } else {
            if (oneway) oneway.style.display = 'flex';
            if (twoway) twoway.style.display = 'none';
            if (hintTwoway) hintTwoway.style.display = 'none';
            if (strictLang) strictLang.style.display = 'flex';
        }
    }

    _escAttr(str) {
        return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ─── Source ───────────────────────────────────────────────────────────────

    _setSource(source) {
        const labels = { system: 'System Audio', microphone: 'Microphone', both: 'System + Mic' };
        if (this.isRunning) {
            this.stop().then(() => {
                this.currentSource = source;
                this._updateSourceButtons();
                this._showToast(`Switched to ${labels[source]}`, 'success');
                this.start();
            });
        } else {
            this.currentSource = source;
            this._updateSourceButtons();
            this._showToast(`Source: ${labels[source]}`, 'success');
        }
    }

    _updateSourceButtons() {
        document.getElementById('btn-source-system').classList.toggle('active', this.currentSource === 'system');
        document.getElementById('btn-source-mic').classList.toggle('active', this.currentSource === 'microphone');
        document.getElementById('btn-source-both').classList.toggle('active', this.currentSource === 'both');
    }

    // ─── Start / Stop ─────────────────────────────────────────────────────────

    async start() {
        this.isRunning = true;
        this._updateStartButton();

        if (!this.transcriptUI.hasContent()) {
            this.transcriptUI.showListening();
        } else {
            this.transcriptUI.clearProvisional();
        }

        const settings = settingsManager.get();
        this._updateStatus('connecting');

        sonioxClient.connect({
            sourceLanguage: settings.source_language,
            targetLanguage: settings.target_language,
            customContext: settings.custom_context,
            translationType: settings.translation_type || 'one_way',
            languageA: settings.language_a,
            languageB: settings.language_b,
            languageHintsStrict: settings.language_hints_strict || false,
            endpointDelay: settings.endpoint_delay || 3000,
        });

        await this._startAudio(this.currentSource);
    }

    async stop() {
        this.isRunning = false;
        this._updateStartButton();
        this._stopAudio();
        sonioxClient.disconnect();
        this.transcriptUI.clearProvisional();
    }

    // ─── Browser Audio Capture ────────────────────────────────────────────────

    async _startAudio(source) {
        const blob = new Blob([PCM_WORKLET_CODE], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);

        try {
            this.audioContext = new AudioContext({ sampleRate: 16000 });
            await this.audioContext.audioWorklet.addModule(blobUrl);
            URL.revokeObjectURL(blobUrl);

            this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor');
            this.workletNode.port.onmessage = (e) => {
                sonioxClient.sendAudio(e.data);
            };

            // Muted output node — keeps worklet active without producing sound
            const silence = this.audioContext.createGain();
            silence.gain.value = 0;
            this.workletNode.connect(silence);
            silence.connect(this.audioContext.destination);

            if (source === 'microphone' || source === 'both') {
                this.micStream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
                    video: false,
                });
                this.audioContext.createMediaStreamSource(this.micStream).connect(this.workletNode);
            }

            if (source === 'system' || source === 'both') {
                try {
                    this.sysStream = await navigator.mediaDevices.getDisplayMedia({
                        audio: true,
                        video: false,
                    });
                } catch (err) {
                    // video: false rejected by some browsers — retry with minimal video
                    this.sysStream = await navigator.mediaDevices.getDisplayMedia({
                        audio: true,
                        video: { width: 1, height: 1 },
                    });
                    // Immediately stop video tracks — we only want audio
                    this.sysStream.getVideoTracks().forEach(t => t.stop());
                }

                if (!this.sysStream.getAudioTracks().length) {
                    this._showToast('No audio track in screen share. Enable "Share system audio" in the prompt.', 'error');
                    await this.stop();
                    return;
                }

                this.audioContext.createMediaStreamSource(this.sysStream).connect(this.workletNode);

                // Auto-stop if user ends the screen share
                this.sysStream.getAudioTracks()[0].addEventListener('ended', () => {
                    if (this.isRunning) this.stop();
                });
            }
        } catch (err) {
            URL.revokeObjectURL(blobUrl);
            console.error('[Audio]', err);
            this._showToast(`Audio error: ${err.message || err}`, 'error');
            await this.stop();
        }
    }

    _stopAudio() {
        if (this.workletNode) {
            try { this.workletNode.disconnect(); this.workletNode.port.close(); } catch (_) {}
            this.workletNode = null;
        }
        if (this.micStream) {
            this.micStream.getTracks().forEach(t => t.stop());
            this.micStream = null;
        }
        if (this.sysStream) {
            this.sysStream.getTracks().forEach(t => t.stop());
            this.sysStream = null;
        }
        if (this.audioContext) {
            this.audioContext.close().catch(() => {});
            this.audioContext = null;
        }
    }

    // ─── UI Updates ───────────────────────────────────────────────────────────

    _updateStartButton() {
        const btn = document.getElementById('btn-start');
        const iconPlay = document.getElementById('icon-play');
        const iconStop = document.getElementById('icon-stop');
        btn.classList.toggle('recording', this.isRunning);
        iconPlay.style.display = this.isRunning ? 'none' : 'block';
        iconStop.style.display = this.isRunning ? 'block' : 'none';
    }

    _updateStatus(status) {
        const dot = document.getElementById('status-indicator');
        const text = document.getElementById('status-text');
        dot.className = 'status-dot';
        switch (status) {
            case 'connecting':  dot.classList.add('connecting');  text.textContent = 'Connecting...'; break;
            case 'connected':   dot.classList.add('connected');   text.textContent = 'Listening'; break;
            case 'disconnected':dot.classList.add('disconnected');text.textContent = 'Ready'; break;
            case 'error':       dot.classList.add('error');       text.textContent = 'Error'; break;
        }
    }

    _toggleViewMode() {
        const isDual = this.transcriptUI.viewMode === 'dual';
        const newMode = isDual ? 'single' : 'dual';
        this.transcriptUI.configure({ viewMode: newMode });
        document.getElementById('btn-view-mode').classList.toggle('active', newMode === 'dual');
    }

    _adjustFontSize(delta) {
        const current = this.transcriptUI.fontSize || 16;
        const newSize = Math.max(12, Math.min(140, current + delta));
        this.transcriptUI.configure({ fontSize: newSize });

        const display = document.getElementById('font-size-display');
        if (display) display.textContent = newSize;
        const slider = document.getElementById('range-font-size');
        if (slider) slider.value = newSize;
        const sliderVal = document.getElementById('font-size-value');
        if (sliderVal) sliderVal.textContent = `${newSize}px`;
    }

    _download(content, mime, basename, ext) {
        const now = new Date();
        const stamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`;
        const blob = new Blob(['\uFEFF' + content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${basename}-${stamp}.${ext}`;
        a.click();
        URL.revokeObjectURL(url);
    }

    _showToast(message, type = 'success') {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        requestAnimationFrame(() => toast.classList.add('show'));

        const duration = type === 'error' ? 5000 : 3000;
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
});
