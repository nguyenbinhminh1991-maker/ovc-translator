/**
 * Settings Manager — localStorage-based, no Tauri dependency
 */

// ─── Defaults ───────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
    source_language: 'auto',
    target_language: 'vi',
    audio_source: 'system',
    overlay_opacity: 0.85,
    font_size: 16,
    max_lines: 5,
    show_original: true,
    custom_context: null,
    translation_type: 'one_way',
    language_a: 'ja',
    language_b: 'vi',
    language_hints_strict: false,
    endpoint_delay: 3000,
};

const STORAGE_KEY = 'translator_settings';

class SettingsManager {
    constructor() {
        this.settings = { ...DEFAULT_SETTINGS };
        this._listeners = [];
    }

    load() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
                this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
            }
        } catch (err) {
            console.error('Failed to load settings:', err);
            this.settings = { ...DEFAULT_SETTINGS };
        }
        this._notify();
        return this.settings;
    }

    save(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
        } catch (err) {
            console.error('Failed to save settings:', err);
            throw err;
        }
        this._notify();
        return true;
    }

    get() {
        return { ...this.settings };
    }

    onChange(callback) {
        this._listeners.push(callback);
        return () => {
            this._listeners = this._listeners.filter(l => l !== callback);
        };
    }

    _notify() {
        const settings = this.get();
        this._listeners.forEach(cb => cb(settings));
    }
}

export const settingsManager = new SettingsManager();
