/*
 * The Accessibility tab of Tools, and what it changes across the app. The choices are app data (app-accessibility):
 *
 * - textSize: the size of text, as a percentage of the usual, from 80 to 160. It scales Web UI's --typography-size,
 *   which text is sized from, and the terminal's font.
 * - reduceMotion: no sliding, fading, or animation. On by default when the system asks for reduced motion.
 * - underlineLinks: links are underlined, so they don't rely on color alone.
 * - strongFocus: a thicker outline around what the keyboard is on.
 * - tooltips: hovered buttons say what they do. On by default.
 *
 * The element sits hidden inside app-tools, so the choices apply from the moment the app starts, and draws its controls
 * into the tab when Tools opens on it.
 */
"use strict"
{
    const KEY = 'app-accessibility';
    const BASE_TEXT = 16;
    const MIN_TEXT = 80;
    const MAX_TEXT = 160;
    const DEFAULTS = { textSize: 100, reduceMotion: null, underlineLinks: false, strongFocus: false, tooltips: true };
    /** The switches the tab offers, with what each does. */
    const SWITCHES = [
        ['reduceMotion', 'Reduce motion', 'Panels, menus and tabs change without sliding or fading.'],
        ['underlineLinks', 'Underline links', 'Links stand out from the text around them by more than their color.'],
        ['strongFocus', 'Stronger focus outline', 'What the keyboard is on gets a thicker outline that is easier to follow.'],
        ['tooltips', 'Show tooltips', 'Buttons say what they do when the pointer rests on them.'],
    ];
    const systemReducesMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    /** The saved choices, with anything missing or unreadable at its default. */
    function settings() {
        const saved = webui.getData(KEY) || {};
        const size = Number(saved.textSize);
        return {
            textSize: Number.isFinite(size) ? Math.min(MAX_TEXT, Math.max(MIN_TEXT, Math.round(size))) : DEFAULTS.textSize,
            reduceMotion: typeof saved.reduceMotion === 'boolean' ? saved.reduceMotion : systemReducesMotion(),
            underlineLinks: saved.underlineLinks === true,
            strongFocus: saved.strongFocus === true,
            tooltips: saved.tooltips !== false,
        };
    }
    webui.define('app-accessibility', {
        connected() {
            const t = this;
            t.dataset.subscribe = `${KEY}:apply`;
            t.apply();
        },
        /** Puts the saved choices into effect across the app. */
        apply() {
            const t = this;
            const chosen = settings();
            const root = document.documentElement;
            const size = `${(BASE_TEXT * chosen.textSize / 100).toFixed(2)}px`;
            if (chosen.textSize === 100) root.style.removeProperty('--typography-size');
            else root.style.setProperty('--typography-size', size);
            root.toggleAttribute('data-reduce-motion', chosen.reduceMotion);
            root.toggleAttribute('data-underline-links', chosen.underlineLinks);
            root.toggleAttribute('data-strong-focus', chosen.strongFocus);
            window.tooltipsEnabled = chosen.tooltips;
            if (t._applied?.textSize !== chosen.textSize) {
                document.dispatchEvent(new CustomEvent('app-text-size', { detail: { scale: chosen.textSize / 100 } }));
            }
            t._applied = chosen;
            t.render();
        },
        save(change) {
            webui.setData(KEY, { ...settings(), ...change });
        },
        /** Draws the tab's controls into `target`. */
        open({ target } = {}) {
            const t = this;
            if (!target) return;
            const panel = webui.create('section', { class: 'accessibility-panel' });
            panel.innerHTML = `
<h4>Text size</h4>
<div class="a11y-text-row">
<input type="range" class="a11y-text-size" min="${MIN_TEXT}" max="${MAX_TEXT}" step="5" aria-label="Text size">
<span class="a11y-text-value" aria-live="polite"></span>
<button type="button" class="a11y-text-reset">Reset</button>
</div>
<p class="a11y-sample">The quick brown fox jumps over the lazy dog.</p>
<h4>More</h4>
<div class="a11y-switches"></div>`;
            // Clicks stay in the panel, as the drawer's data-stopclick asks. Web UI's loader also cancelled the clicks it
            // stopped, which kept checkboxes from changing, so they never reach it.
            panel.addEventListener('click', ev => ev.stopPropagation());
            const slider = panel.querySelector('.a11y-text-size');
            slider.addEventListener('input', () => t.showTextSize(Number(slider.value)));
            slider.addEventListener('change', () => t.save({ textSize: Number(slider.value) }));
            panel.querySelector('.a11y-text-reset').addEventListener('click', () => t.save({ textSize: 100 }));
            const list = panel.querySelector('.a11y-switches');
            SWITCHES.forEach(([key, label, note]) => {
                const row = webui.create('label', { class: 'a11y-switch' });
                const box = webui.create('input', { type: 'checkbox', 'data-setting': key });
                box.addEventListener('change', () => t.save({ [key]: box.checked }));
                const text = webui.create('span', { class: 'a11y-switch-text' });
                text.append(webui.create('strong', { text: label }), webui.create('span', { class: 'a11y-note', text: note }));
                row.append(box, text);
                list.appendChild(row);
            });
            t._panel = panel;
            target.replaceChildren(panel);
            t.render();
        },
        /** Shows the saved choices in the tab, when it is drawn. */
        render() {
            const t = this;
            const panel = t._panel;
            if (!panel?.isConnected) return;
            const chosen = settings();
            panel.querySelector('.a11y-text-size').value = `${chosen.textSize}`;
            t.showTextSize(chosen.textSize);
            panel.querySelectorAll('input[data-setting]').forEach(box => { box.checked = !!chosen[box.dataset.setting]; });
        },
        showTextSize(value) {
            const label = this._panel?.querySelector('.a11y-text-value');
            if (label) label.textContent = `${value}%`;
        },
    });
}
