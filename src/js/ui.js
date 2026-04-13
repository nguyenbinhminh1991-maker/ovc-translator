/**
 * Transcript UI — continuous paragraph flow display with speaker diarization
 * 
 * Design: All text flows as one continuous paragraph.
 * - Translated text: white (primary color)
 * - Original text (pending translation): cyan/accent color  
 * - Provisional text (being recognized): dimmed
 * - Speaker labels: shown when speaker changes (e.g. "Speaker 1:")
 * - Language badges: shown when detected language changes (e.g. "🇯🇵 JA")
 * - Confidence: low-confidence segments highlighted
 */

export class TranscriptUI {
    constructor(container) {
        this.container = container;
        this.contentEl = null;
        this.maxChars = 1200;
        this.fontSize = 16;
        this.viewMode = 'single'; // 'single' or 'dual'

        // Segments: each has { original, translation, status, speaker, language, confidence }
        this.segments = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this.currentSpeaker = null; // Track current speaker to detect changes
        this.currentLanguage = null; // Track current language to detect changes
        this.lastConfidence = null; // Last confidence score from Soniox
    }

    /**
     * Update display settings
     */
    configure({ maxLines, showOriginal, fontSize, fontColor, viewMode }) {
        if (maxLines !== undefined) this.maxChars = maxLines * 160;
        if (fontSize !== undefined) {
            this.fontSize = fontSize;
            this.container.style.setProperty('--transcript-font-size', `${fontSize}px`);
        }
        if (fontColor !== undefined) {
            this.fontColor = fontColor;
            this.container.style.setProperty('--transcript-font-color', fontColor);
        }
        if (viewMode !== undefined) {
            this.viewMode = viewMode;
            const overlay = document.getElementById('overlay-view');
            if (overlay) {
                overlay.classList.toggle('dual-view', viewMode === 'dual');
            }
            this._render();
        }
    }

    /**
     * Add finalized original text (pending translation)
     */
    addOriginal(text, speaker, language) {
        this._removeListening();
        const seg = {
            original: text,
            translation: null,
            status: 'original',
            speaker: speaker || null,
            language: language || null,
            confidence: this.lastConfidence,
            createdAt: Date.now(),
        };
        this.segments.push(seg);
        if (speaker) this.currentSpeaker = speaker;
        if (language) this.currentLanguage = language;
        this._cleanupStaleOriginals();
        this._render();
    }

    /**
     * Apply translation to the oldest untranslated segment
     */
    addTranslation(text) {
        const seg = this.segments.find(s => s.status === 'original');
        if (seg) {
            seg.translation = text;
            seg.status = 'translated';
        } else {
            this.segments.push({ original: '', translation: text, status: 'translated', speaker: null, createdAt: Date.now() });
        }
        this._render();
    }

    /**
     * Update provisional (in-progress) text
     */
    setProvisional(text, speaker, language) {
        this._removeListening();
        this.provisionalText = text;
        this.provisionalSpeaker = speaker || null;
        this.provisionalLanguage = language || null;
        this._render();
    }

    /**
     * Clear provisional text
     */
    clearProvisional() {
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this._render();
    }

    /**
     * Check if there is any content to display
     */
    hasContent() {
        return this.segments.length > 0 || this.provisionalText ||
            !!this.container.querySelector('.listening-indicator');
    }

    /**
     * Show placeholder state
     */
    showPlaceholder() {
        this.container.innerHTML = `
      <div class="transcript-placeholder">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
        <p>Press ▶ to start translating</p>
        <p class="shortcut-hint">Ctrl+Enter</p>
      </div>
    `;
        this.segments = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this.currentSpeaker = null;
        this.currentLanguage = null;
        this.lastConfidence = null;
        this.contentEl = null;
    }

    /**
     * Show listening state
     */
    showListening() {
        // Remove existing indicators first (prevent duplicates)
        this.container.querySelectorAll('.listening-indicator').forEach(el => el.remove());

        const placeholder = this.container.querySelector('.transcript-placeholder');
        if (placeholder) placeholder.remove();

        this._ensureContent();

        const indicator = document.createElement('div');
        indicator.className = 'listening-indicator';
        indicator.innerHTML = `
            <div class="listening-waves">
                <span></span><span></span><span></span><span></span><span></span>
            </div>
            <p>Listening...</p>
        `;
        this.contentEl.appendChild(indicator);
    }

    /**
     * Show status message in transcript area (e.g. loading model)
     */
    showStatusMessage(message) {
        this._ensureContent();
        let statusEl = this.contentEl.querySelector('.pipeline-status');
        if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.className = 'pipeline-status';
            statusEl.style.cssText = 'text-align:center; padding:8px; color:rgba(255,255,255,0.5); font-size:13px;';
            this.contentEl.appendChild(statusEl);
        }
        statusEl.textContent = message;
    }

    /**
     * Remove status message
     */
    removeStatusMessage() {
        if (this.contentEl) {
            const statusEl = this.contentEl.querySelector('.pipeline-status');
            if (statusEl) statusEl.remove();
        }
    }

    /**
     * Get transcript as plain text for copying (original + translation per turn)
     */
    getPlainText() {
        const turns = this._groupByTurn();
        const lines = [];
        for (const turn of turns) {
            if (turn.original) lines.push(turn.original.trim());
            if (turn.translation) lines.push(turn.translation.trim());
            if (turn.original || turn.translation) lines.push('');
        }
        if (this.provisionalText) lines.push(this.provisionalText.trim());
        return lines.join('\n').trim();
    }

    /**
     * Get formatted .txt content — speaker label, original, indented translation
     */
    getSaveText() {
        const turns = this._groupByTurn();
        if (!turns.length) return null;
        const lines = [];
        for (const turn of turns) {
            const label = turn.speaker ? `[Speaker ${turn.speaker}]` : '[Speaker]';
            lines.push(label);
            if (turn.original) lines.push(turn.original.trim());
            if (turn.translation) lines.push('  ' + turn.translation.trim());
            lines.push('');
        }
        return lines.join('\n').trim();
    }

    /**
     * Get CSV content — Timestamp, Speaker, Original, Translation
     */
    getCSVText() {
        const turns = this._groupByTurn();
        if (!turns.length) return null;
        const q = s => `"${(s || '').replace(/"/g, '""').trim()}"`;
        const rows = ['Timestamp,Speaker,Original,Translation'];
        for (const turn of turns) {
            rows.push([
                q(this._formatTime(turn.createdAt)),
                q(turn.speaker ? `Speaker ${turn.speaker}` : ''),
                q(turn.original),
                q(turn.translation),
            ].join(','));
        }
        return rows.join('\n');
    }

    _formatTime(ts) {
        const d = new Date(ts);
        return [d.getHours(), d.getMinutes(), d.getSeconds()]
            .map(n => String(n).padStart(2, '0')).join(':');
    }

    /**
     * Clear display buffer (segments array).
     */
    clear() {
        this.container.innerHTML = '';
        this.segments = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this.currentSpeaker = null;
        this.currentLanguage = null;
        this.lastConfidence = null;
        this.contentEl = null;
    }

    hasSegments() {
        return this.segments.length > 0;
    }

    /**
     * Update confidence score
     */
    setConfidence(confidence) {
        this.lastConfidence = confidence;
    }

    // ─── Internal ──────────────────────────────────────────

    _ensureContent() {
        if (!this.contentEl) {
            this.container.innerHTML = '';
            this.contentEl = document.createElement('div');
            this.contentEl.className = 'transcript-flow';
            this.container.appendChild(this.contentEl);
        }
    }

    _removeListening() {
        const indicator = this.container.querySelector('.listening-indicator');
        if (indicator) indicator.remove();
    }

    _render() {
        this._ensureContent();
        this._trimSegments();

        if (this.viewMode === 'dual') {
            this._renderDual();
        } else {
            this._renderSingle();
        }
    }

    _renderSingle() {
        const turns = this._groupByTurn();
        let html = '';
        let lastRenderedSpeaker = null;
        let lastRenderedLang = null;

        for (const turn of turns) {
            if (turn.speaker && turn.speaker !== lastRenderedSpeaker) {
                html += `<span class="speaker-label">Speaker ${turn.speaker}:</span> `;
                lastRenderedSpeaker = turn.speaker;
            }
            if (turn.language && turn.language !== lastRenderedLang) {
                html += `<span class="lang-badge">${this._langEmoji(turn.language)}</span> `;
                lastRenderedLang = turn.language;
            }
            if (turn.translation) {
                const cls = (turn.confidence !== null && turn.confidence < 0.7) ? ' low-confidence' : '';
                html += `<div class="seg-block"><div class="seg-translated${cls}">${this._esc(turn.translation.trim())}</div></div>`;
            } else if (turn.original) {
                html += `<div class="seg-block"><div class="seg-provisional">${this._esc(turn.original.trim())}</div></div>`;
            }
        }

        if (this.provisionalText) {
            if (this.provisionalSpeaker && this.provisionalSpeaker !== lastRenderedSpeaker) {
                html += `<span class="speaker-label">Speaker ${this.provisionalSpeaker}:</span> `;
            }
            if (this.provisionalLanguage && this.provisionalLanguage !== lastRenderedLang) {
                html += `<span class="lang-badge">${this._langEmoji(this.provisionalLanguage)}</span> `;
            }
            html += `<div class="seg-block"><div class="seg-provisional">${this._esc(this.provisionalText)}</div></div>`;
        }

        this.contentEl.innerHTML = html;
        this._smartScroll(this.container.parentElement || this.container);
    }

    _renderDual() {
        const oldSrcPanel = this.contentEl.querySelector('.panel-source');
        const oldTgtPanel = this.contentEl.querySelector('.panel-translation');
        const srcScrollState = oldSrcPanel ? this._getScrollState(oldSrcPanel) : { nearBottom: true, scrollTop: 0 };
        const tgtScrollState = oldTgtPanel ? this._getScrollState(oldTgtPanel) : { nearBottom: true, scrollTop: 0 };

        const turns = this._groupByTurn();
        let srcHtml = '';
        let tgtHtml = '';

        turns.forEach((turn, i) => {
            const speakerHtml = turn.speaker
                ? `<div class="speaker-label">Speaker ${turn.speaker}:</div>` : '';
            const langHtml = turn.language
                ? `<span class="lang-badge">${this._langEmoji(turn.language)}</span>` : '';
            const cls = (turn.confidence !== null && turn.confidence < 0.7) ? ' low-confidence' : '';

            // Source cell — speaker label + lang badge + original text
            srcHtml += `<div class="turn-block" data-turn="${i}">`;
            srcHtml += speakerHtml + langHtml;
            srcHtml += `<div class="seg-text">${this._esc(turn.original.trim())}</div>`;
            srcHtml += `</div>`;

            // Translation cell — same speaker label + translated text
            tgtHtml += `<div class="turn-block" data-turn="${i}">`;
            tgtHtml += speakerHtml;
            tgtHtml += turn.translation
                ? `<div class="seg-text${cls}">${this._esc(turn.translation.trim())}</div>`
                : `<div class="seg-text pending">...</div>`;
            tgtHtml += `</div>`;
        });

        if (this.provisionalText) {
            srcHtml += `<div class="turn-block provisional"><div class="seg-text pending">${this._esc(this.provisionalText)}</div></div>`;
            tgtHtml += `<div class="turn-block provisional"><div class="seg-text pending">...</div></div>`;
        }

        this.contentEl.innerHTML = `
            <div class="panel-source">${srcHtml}</div>
            <div class="panel-translation">${tgtHtml}</div>
        `;

        const srcPanel = this.contentEl.querySelector('.panel-source');
        const tgtPanel = this.contentEl.querySelector('.panel-translation');

        // Heights and scroll sync are applied after paint so offsetHeight is accurate
        requestAnimationFrame(() => {
            this._syncTurnHeights(srcPanel, tgtPanel);
            // Restore scroll positions after height changes settle
            if (srcPanel) srcScrollState.nearBottom
                ? (srcPanel.scrollTop = srcPanel.scrollHeight)
                : (srcPanel.scrollTop = srcScrollState.scrollTop);
            if (tgtPanel) tgtScrollState.nearBottom
                ? (tgtPanel.scrollTop = tgtPanel.scrollHeight)
                : (tgtPanel.scrollTop = tgtScrollState.scrollTop);
            this._setupScrollSync(srcPanel, tgtPanel);
        });
    }

    /** Match the height of each turn-block pair so rows stay visually aligned. */
    _syncTurnHeights(srcPanel, tgtPanel) {
        if (!srcPanel || !tgtPanel) return;
        const srcBlocks = srcPanel.querySelectorAll('.turn-block');
        const tgtBlocks = tgtPanel.querySelectorAll('.turn-block');
        srcBlocks.forEach((srcEl, i) => {
            const tgtEl = tgtBlocks[i];
            if (!tgtEl) return;
            srcEl.style.minHeight = '';
            tgtEl.style.minHeight = '';
            const maxH = Math.max(srcEl.offsetHeight, tgtEl.offsetHeight);
            srcEl.style.minHeight = `${maxH}px`;
            tgtEl.style.minHeight = `${maxH}px`;
        });
    }

    /** Wire proportional scroll sync between the two panels. */
    _setupScrollSync(srcPanel, tgtPanel) {
        if (!srcPanel || !tgtPanel) return;
        let syncing = false;
        srcPanel.addEventListener('scroll', () => {
            if (syncing) return;
            syncing = true;
            const ratio = srcPanel.scrollTop / Math.max(1, srcPanel.scrollHeight - srcPanel.clientHeight);
            tgtPanel.scrollTop = ratio * (tgtPanel.scrollHeight - tgtPanel.clientHeight);
            syncing = false;
        });
        tgtPanel.addEventListener('scroll', () => {
            if (syncing) return;
            syncing = true;
            const ratio = tgtPanel.scrollTop / Math.max(1, tgtPanel.scrollHeight - tgtPanel.clientHeight);
            srcPanel.scrollTop = ratio * (srcPanel.scrollHeight - srcPanel.clientHeight);
            syncing = false;
        });
    }

    /**
     * Merge consecutive same-speaker segments into speaker turns.
     * Each turn: { speaker, language, original, translation, hasPending, confidence, createdAt }
     */
    _groupByTurn() {
        const turns = [];
        for (const seg of this.segments) {
            const last = turns[turns.length - 1];
            if (last && last.speaker === seg.speaker) {
                last.original += seg.original || '';
                if (seg.translation) last.translation += seg.translation;
                else if (seg.original) last.hasPending = true;
                last.confidence = seg.confidence ?? last.confidence;
            } else {
                turns.push({
                    speaker: seg.speaker,
                    language: seg.language,
                    original: seg.original || '',
                    translation: seg.translation || '',
                    hasPending: !seg.translation && !!seg.original,
                    confidence: seg.confidence,
                    createdAt: seg.createdAt,
                });
            }
        }
        return turns;
    }

    _getScrollState(el) {
        return {
            nearBottom: (el.scrollHeight - el.scrollTop - el.clientHeight) < 100,
            scrollTop: el.scrollTop
        };
    }

    _smartScroll(el) {
        const isNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 100;
        if (isNearBottom) {
            el.scrollTop = el.scrollHeight;
        }
    }

    _trimSegments() {
        let totalLen = 0;
        for (const seg of this.segments) {
            totalLen += (seg.translation || seg.original || '').length;
        }
        while (totalLen > this.maxChars && this.segments.length > 2) {
            const removed = this.segments.shift();
            totalLen -= (removed.translation || removed.original || '').length;
        }
    }

    /**
     * Remove stale original segments that never received translation.
     * - Originals older than 10s are removed
     * - Max 3 pending originals allowed (oldest dropped)
     */
    _cleanupStaleOriginals() {
        const now = Date.now();
        const STALE_MS = 10000; // 10 seconds
        const MAX_PENDING = 3;

        // Remove originals older than STALE_MS
        this.segments = this.segments.filter(seg => {
            if (seg.status === 'original' && (now - seg.createdAt) > STALE_MS) {
                return false; // drop stale
            }
            return true;
        });

        // If still too many pending originals, drop oldest
        let pending = this.segments.filter(s => s.status === 'original');
        while (pending.length > MAX_PENDING) {
            const oldest = pending.shift();
            const idx = this.segments.indexOf(oldest);
            if (idx !== -1) this.segments.splice(idx, 1);
        }
    }

    _esc(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Get language flag emoji + code
     */
    _langEmoji(langCode) {
        const flags = {
            'en': '🇬🇧', 'ja': '🇯🇵', 'ko': '🇰🇷', 'zh': '🇨🇳',
            'vi': '🇻🇳', 'fr': '🇫🇷', 'de': '🇩🇪', 'es': '🇪🇸',
            'th': '🇹🇭', 'id': '🇮🇩', 'pt': '🇵🇹', 'ru': '🇷🇺',
            'ar': '🇸🇦', 'hi': '🇮🇳', 'it': '🇮🇹', 'nl': '🇳🇱',
            'pl': '🇵🇱', 'tr': '🇹🇷', 'sv': '🇸🇪', 'da': '🇩🇰',
            'no': '🇳🇴', 'fi': '🇫🇮', 'el': '🇬🇷', 'cs': '🇨🇿',
            'ro': '🇷🇴', 'hu': '🇭🇺', 'uk': '🇺🇦', 'he': '🇮🇱',
            'ms': '🇲🇾', 'tl': '🇵🇭', 'bn': '🇧🇩', 'ta': '🇱🇰',
        };
        const flag = flags[langCode] || '🌐';
        return `${flag} ${langCode.toUpperCase()}`;
    }
}
