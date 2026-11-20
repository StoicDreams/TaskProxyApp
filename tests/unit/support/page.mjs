// A small Playwright-shaped API over a jsdom window, so component tests read as they did in the browser:
// page.locator(...).click(), await expect(locator).toHaveText(...). Locators pierce open shadow roots as Playwright's
// do, find their elements again on every call, and the matchers retry until they pass or time out.
//
// Only what layout-free tests need is here. Geometry and the mouse belong to the browser tests in
// tests/browser, and calling them here throws to say so.
import FakeTimers from '@sinonjs/fake-timers';
import { expect } from 'vitest';

// How long a matcher retries, as the browser tier's expect timeout (15 s, playwright.config.mjs).
const TIMEOUT = 15000;
// How long an action or wait looks for its element: Playwright's have no limit but the test's, so these stop just
// short of the test timeout (vitest.config.mjs), with a message saying what was missing.
const ACTION_TIMEOUT = 50000;
const INTERVAL = 5;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Splits a selector at its descendant combinators, keeping > + ~ chains, brackets and parentheses whole. */
function splitDescendants(selector) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (let i = 0; i < selector.length; i++) {
        const ch = selector[i];
        if (quote) {
            current += ch;
            if (ch === quote && selector[i - 1] !== '\\') quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
        if (ch === '[' || ch === '(') depth++;
        if (ch === ']' || ch === ')') depth--;
        if (depth === 0 && /\s/.test(ch)) {
            const rest = selector.slice(i).trimStart();
            const before = current.trimEnd();
            if (/[>+~]$/.test(before) || /^[>+~]/.test(rest)) { current += ' '; continue; }
            if (current.trim()) parts.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

/** Every shadow root inside a node, at any depth, the node's own included. */
function scopesWithin(node) {
    const scopes = [node];
    const visit = scope => {
        for (const el of scope.querySelectorAll ? scope.querySelectorAll('*') : []) {
            if (el.shadowRoot) {
                scopes.push(el.shadowRoot);
                visit(el.shadowRoot);
            }
        }
    };
    if (node.shadowRoot) {
        scopes.push(node.shadowRoot);
        visit(node.shadowRoot);
    }
    visit(node);
    return scopes;
}

/** Splits a selector list at its top-level commas. */
function splitList(selector) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (let i = 0; i < selector.length; i++) {
        const ch = selector[i];
        if (quote) {
            current += ch;
            if (ch === quote && selector[i - 1] !== '\\') quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        if (ch === '[' || ch === '(') depth++;
        if (ch === ']' || ch === ')') depth--;
        if (ch === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

/** Sorts elements into document order, across shadow roots, as a page lists them. */
function documentOrder(elements) {
    const position = el => {
        const path = [];
        let node = el;
        while (node) {
            const parent = node.parentNode || node.host;
            if (!parent) break;
            const siblings = node.parentNode ? [...node.parentNode.childNodes] : [];
            // A shadow root comes before its host's own children.
            path.unshift(node.parentNode ? siblings.indexOf(node) + 1 : 0);
            node = parent;
        }
        return path;
    };
    return elements.map(el => [el, position(el)]).sort(([, a], [, b]) => {
        for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
        return a.length - b.length;
    }).map(([el]) => el);
}

/** querySelectorAll that pierces shadow roots, matching Playwright's CSS engine closely enough for these tests. */
export function pierce(root, selector) {
    const list = splitList(selector);
    if (list.length > 1) return documentOrder([...new Set(list.flatMap(part => pierceOne(root, part)))]);
    return pierceOne(root, selector);
}

function pierceOne(root, selector) {
    const parts = splitDescendants(selector);
    let current = [root];
    parts.forEach((rawPart, index) => {
        // Playwright's :visible is not CSS: it is matched here, as an element that shows.
        const visibleOnly = /:visible\b/.test(rawPart);
        // So are :text-is("…") (the whole text), and :has-text("…") and :text("…") (contains, ignoring case).
        const textChecks = [];
        // :has(…) is matched here too, by finding its selector within the element across shadow roots, as Playwright's
        // CSS does. So is a :not(…) of more than one element (`:not(a b)`), or of any of Playwright's own.
        let withHas = rawPart;
        for (const pseudo of [':has(', ':not(']) {
            for (let at = withHas.indexOf(pseudo); at >= 0; at = withHas.indexOf(pseudo, at)) {
                let depth = 0, end = at + pseudo.length - 1;
                for (; end < withHas.length; end++) {
                    if (withHas[end] === '(') depth++;
                    else if (withHas[end] === ')' && --depth === 0) break;
                }
                const inner = withHas.slice(at + pseudo.length, end);
                if (pseudo === ':has(') {
                    textChecks.push(el => pierce(el, inner).length > 0);
                } else if (/[\s>+~]/.test(inner.trim()) || /:(visible|text-is|has-text|text|has)\b/.test(inner)) {
                    let matched = null;
                    textChecks.push(el => !(matched ??= new Set(pierce(el.ownerDocument, inner))).has(el));
                } else {
                    at = end;
                    continue;
                }
                withHas = withHas.slice(0, at) + withHas.slice(end + 1);
            }
        }
        let part = withHas.replace(/:visible\b/g, '').replace(/:(text-is|has-text|text)\((["'])(.*?)\2\)/g, (_, kind, __, value) => {
            textChecks.push(el => {
                const text = normalize(renderedText(el));
                return kind === 'text-is' ? text === value : text.toLowerCase().includes(value.toLowerCase());
            });
            return '';
        });
        if (!part || /[>+~]$/.test(part.trim())) part = `${part}*`;
        const next = new Set();
        for (const base of current) {
            for (const scope of scopesWithin(base)) {
                const relative = /^[>+~]/.test(part) || /^:scope\b/.test(part);
                if (scope !== base && relative) continue;
                let found = [];
                try {
                    found = scope === base && /^[>+~]/.test(part) ? base.querySelectorAll(`:scope ${part}`) : scope.querySelectorAll(part);
                } catch {
                    found = [];
                }
                for (const el of found) next.add(el);
            }
        }
        current = [...next].filter(el => (!visibleOnly || isShown(el)) && textChecks.every(check => check(el)));
        if (index === 0 && root.nodeType === 9) current = current.filter(el => el !== root);
    });
    return current.filter(el => el !== root);
}

/** Text as a person reads it: text of the light DOM, or of the shadow root with each slot replaced by what it shows. */
export function renderedText(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.data;
    if (node.nodeType !== 1 && node.nodeType !== 11) return '';
    const name = node.localName;
    if (name === 'style' || name === 'script' || name === 'template') return '';
    if (name === 'slot') {
        const assigned = node.assignedNodes ? node.assignedNodes({ flatten: true }) : [];
        const nodes = assigned.length ? assigned : [...node.childNodes];
        return nodes.map(renderedText).join('');
    }
    if (name === 'input' || name === 'textarea' || name === 'select') return '';
    const children = node.shadowRoot ? [...node.shadowRoot.childNodes] : [...node.childNodes];
    // As Playwright reads it: the text nodes joined, with nothing added between blocks.
    return children.map(renderedText).join('');
}

const normalize = text => `${text ?? ''}`.replace(/\s+/g, ' ').trim();

import { cancelTopModal, isShown, mediaMatcher, whyHidden } from './stand-ins.mjs';
export { isShown };

/** The ARIA role of an element: its role attribute, or the implicit one for common elements. */
function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const name = el.localName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (name === 'button' || (name === 'input' && ['button', 'submit', 'reset', 'image'].includes(type))) return 'button';
    if (name === 'a' && el.hasAttribute('href')) return 'link';
    if (/^h[1-6]$/.test(name)) return 'heading';
    if (name === 'input' && type === 'checkbox') return 'checkbox';
    if (name === 'input' && type === 'radio') return 'radio';
    if (name === 'input' && type === 'range') return 'slider';
    if (name === 'input' && type === 'search') return 'searchbox';
    if ((name === 'input' && ['', 'text', 'email', 'tel', 'url', 'password', 'number'].includes(type)) || name === 'textarea') return type === 'number' ? 'spinbutton' : 'textbox';
    if (name === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (name === 'option') return 'option';
    if (name === 'ul' || name === 'ol') return 'list';
    if (name === 'li') return 'listitem';
    if (name === 'dialog') return 'dialog';
    if (name === 'nav') return 'navigation';
    if (name === 'main') return 'main';
    if (name === 'table') return 'table';
    if (name === 'tr') return 'row';
    if (name === 'td') return 'cell';
    if (name === 'th') return 'columnheader';
    if (name === 'img') return 'img';
    if (name === 'progress') return 'progressbar';
    if (name === 'summary') return 'button';
    if (name === 'details') return 'group';
    if (name === 'fieldset') return 'group';
    if (name === 'section' && (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby'))) return 'region';
    if (name === 'form') return 'form';
    return null;
}

/** The accessible name of an element, close to how a browser works it out for these tests. */
function nameOf(el) {
    const root = el.getRootNode();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
        const text = labelledby.split(/\s+/).map(id => root.getElementById?.(id) || el.ownerDocument.getElementById(id)).filter(Boolean).map(renderedText).join(' ');
        if (normalize(text)) return normalize(text);
    }
    const label = el.getAttribute('aria-label');
    if (label) return normalize(label);
    // Fields and buttons are named by their labels (a label for them in the same root, or around them), as browsers do.
    if (['input', 'textarea', 'select', 'button', 'meter', 'output', 'progress'].includes(el.localName)) {
        if (el.id) {
            const forLabel = root.querySelector?.(`label[for="${el.id.replace(/"/g, '\\"')}"]`);
            if (forLabel && normalize(renderedText(forLabel))) return normalize(renderedText(forLabel));
        }
        const wrapping = el.closest('label');
        if (wrapping && normalize(renderedText(wrapping))) return normalize(renderedText(wrapping));
    }
    if (['input', 'textarea', 'select'].includes(el.localName)) {
        if (['button', 'submit', 'reset'].includes(el.type)) return normalize(el.value);
        return normalize(el.getAttribute('placeholder') || el.getAttribute('title') || '');
    }
    if (el.localName === 'img') return normalize(el.getAttribute('alt') || el.getAttribute('title') || '');
    // A fieldset is named by its legend.
    if (el.localName === 'fieldset') {
        const legend = [...el.children].find(child => child.localName === 'legend');
        if (legend) return normalize(renderedText(legend));
    }
    const text = normalize(renderedText(el));
    return text || normalize(el.getAttribute('title') || '');
}

function textMatches(actual, expected, { exact = false } = {}) {
    if (expected instanceof RegExp) return expected.test(actual);
    const want = normalize(expected);
    return exact ? actual === want : actual.toLowerCase().includes(want.toLowerCase());
}

/** A way of finding elements again whenever it is used, as a Playwright locator does. */
export class Locator {
    constructor(page, resolve, description) {
        this._page = page;
        this._resolve = resolve;
        this._description = description;
    }
    page() { return this._page; }
    toString() { return this._description; }
    all() { return this._resolve(); }
    elements() { return this._resolve(); }
    element() {
        const found = this._resolve();
        return found[0] || null;
    }
    async _one() {
        const deadline = Date.now() + ACTION_TIMEOUT;
        for (; ;) {
            const found = this._resolve();
            if (found.length) return found[0];
            if (Date.now() > deadline) throw new Error(`No element for ${this._description}`);
            await sleep(INTERVAL);
        }
    }
    locator(selector, options) {
        // Playwright's xpath= selectors, and '..' for the parent element. XPath does not cross shadow roots, as there.
        const xpath = selector === '..' ? '..' : selector.startsWith('xpath=') ? selector.slice(6) : null;
        const find = xpath ? el => {
            const doc = el.ownerDocument || el;
            const result = doc.evaluate(xpath, el, null, doc.defaultView.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            return Array.from({ length: result.snapshotLength }, (_, i) => result.snapshotItem(i)).filter(node => node.nodeType === 1);
        } : el => pierce(el, selector);
        const inner = new Locator(this._page, () => {
            const seen = new Set();
            for (const el of this._resolve()) for (const match of find(el)) seen.add(match);
            return [...seen];
        }, `${this._description} >> ${selector}`);
        return options ? inner.filter(options) : inner;
    }
    /** The elements this locator and the other both find, as Playwright's and(). */
    and(other) {
        return new Locator(this._page, () => {
            const theirs = new Set(other.elements());
            return this._resolve().filter(el => theirs.has(el));
        }, `${this._description} >> and(${other})`);
    }
    /** The elements either locator finds, in page order, as Playwright's or(). */
    or(other) {
        return new Locator(this._page, () => documentOrder([...new Set([...this._resolve(), ...other.elements()])]), `${this._description} >> or(${other})`);
    }
    getByRole(role, options = {}) {
        return this._by(el => roleOf(el) === role
            && (options.name === undefined || textMatches(nameOf(el), options.name, options))
            && (options.checked === undefined || el.checked === options.checked || el.getAttribute('aria-checked') === `${options.checked}`)
            && (options.level === undefined || el.localName === `h${options.level}` || el.getAttribute('aria-level') === `${options.level}`)
            && (options.includeHidden || isShown(el)), `role=${role}${options.name ? `[name=${options.name}]` : ''}`);
    }
    getByText(text, options = {}) {
        return this._by(el => {
            if (['style', 'script', 'template', 'slot'].includes(el.localName)) return false;
            const own = normalize(renderedText(el));
            if (!textMatches(own, text, options)) return false;
            // The innermost element with the text, as Playwright picks.
            // A host's rendered children are in its shadow root, and a slot's are the elements assigned to it.
            // A slot is never the match, so one among the children stands for the elements assigned to it.
            const children = (el.shadowRoot ? [...el.shadowRoot.children] : [...el.children])
                .flatMap(child => child.localName === 'slot' ? (child.assignedElements?.({ flatten: true }) ?? []) : [child]);
            return !children.some(child => textMatches(normalize(renderedText(child)), text, options));
        }, `text=${text}`);
    }
    getByLabel(text, options = {}) {
        return this._by(el => ['input', 'textarea', 'select'].includes(el.localName) && textMatches(nameOf(el), text, options), `label=${text}`);
    }
    getByTitle(text, options = {}) {
        return this._by(el => el.hasAttribute('title') && textMatches(normalize(el.getAttribute('title')), text, options), `title=${text}`);
    }
    getByPlaceholder(text, options = {}) {
        return this._by(el => el.hasAttribute('placeholder') && textMatches(normalize(el.getAttribute('placeholder')), text, options), `placeholder=${text}`);
    }
    _by(test, description) {
        return new Locator(this._page, () => {
            const seen = new Set();
            for (const base of this._resolve()) for (const el of pierce(base, '*')) if (test(el)) seen.add(el);
            return [...seen];
        }, `${this._description} >> ${description}`);
    }
    filter({ hasText, hasNotText, has, hasNot, visible } = {}) {
        return new Locator(this._page, () => this._resolve().filter(el => {
            if (hasText !== undefined && !textMatches(normalize(renderedText(el)), hasText)) return false;
            if (hasNotText !== undefined && textMatches(normalize(renderedText(el)), hasNotText)) return false;
            if (has && !has.elements().some(inner => el.contains(inner) || el.shadowRoot?.contains(inner))) return false;
            if (hasNot && hasNot.elements().some(inner => el.contains(inner) || el.shadowRoot?.contains(inner))) return false;
            if (visible !== undefined && isShown(el) !== visible) return false;
            return true;
        }), `${this._description} >> filter`);
    }
    /** The document inside an iframe, as Playwright's frame locator. jsdom does not load srcdoc, so it is written in. */
    contentFrame() {
        return new Locator(this._page, () => {
            const frame = this.element();
            if (!frame) return [];
            const doc = frame.contentDocument;
            if (!doc) return [];
            const srcdoc = frame.getAttribute('srcdoc');
            if (srcdoc !== null && frame.__writtenSrcdoc !== srcdoc) {
                doc.open();
                doc.write(srcdoc);
                doc.close();
                frame.__writtenSrcdoc = srcdoc;
            }
            return [doc];
        }, `${this._description} >> frame`);
    }
    nth(index) {
        return new Locator(this._page, () => {
            const found = this._resolve();
            const el = index < 0 ? found[found.length + index] : found[index];
            return el ? [el] : [];
        }, `${this._description} >> nth=${index}`);
    }
    first() { return this.nth(0); }
    last() { return this.nth(-1); }
    async count() { return this._resolve().length; }
    async evaluate(fn, arg) { return this._page._call(fn, await this._one(), arg); }
    async evaluateAll(fn, arg) { return this._page._call(fn, this._resolve(), arg); }
    async getAttribute(name) { return (await this._one()).getAttribute(name); }
    async textContent() { return (await this._one()).textContent; }
    async innerText() { return normalize(renderedText(await this._one())); }
    async inputValue() { return (await this._one()).value; }
    async isVisible() { return isShown(this.element()); }
    async isHidden() { return !isShown(this.element()); }
    async isChecked() { const el = await this._one(); return !!el.checked || el.getAttribute('aria-checked') === 'true'; }
    async isDisabled() { return isDisabled(await this._one()); }
    async isEnabled() { return !isDisabled(await this._one()); }
    async focus() { (await this._one()).focus(); await this._page.settle(); }
    async blur() { (await this._one()).blur(); await this._page.settle(); }
    async scrollIntoViewIfNeeded() { await this._one(); }
    async waitFor({ state = 'visible', timeout = ACTION_TIMEOUT } = {}) {
        const deadline = Date.now() + timeout;
        for (; ;) {
            const el = this.element();
            const done = state === 'attached' ? !!el
                : state === 'detached' ? !el
                    : state === 'hidden' ? !el || !isShown(el)
                        : !!el && isShown(el);
            if (done) return;
            if (Date.now() > deadline) {
                throw new Error(`${this._description} did not become ${state}: ${el ? `found, ${isShown(el) ? 'shown' : `not shown (${whyHidden(el)})`}` : 'no element'}`);
            }
            await sleep(INTERVAL);
        }
    }
    async dispatchEvent(type, init = {}) {
        const el = await this._one();
        const win = el.ownerDocument.defaultView;
        el.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true, composed: true, ...init }));
        await this._page.settle();
    }
    async hover() {
        const el = await this._one();
        const win = el.ownerDocument.defaultView;
        for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
            el.dispatchEvent(new win.MouseEvent(type, { bubbles: !type.endsWith('enter'), composed: true }));
        }
        await this._page.settle();
    }
    async click(options = {}) {
        const el = await this._one();
        if (!options.force) await this._actionable(el);
        clickElement(el, options);
        await this._page.settle();
    }
    async dblclick(options = {}) {
        const el = await this._one();
        if (!options.force) await this._actionable(el);
        clickElement(el, options);
        clickElement(el, { ...options, detail: 2 });
        const win = el.ownerDocument.defaultView;
        el.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, detail: 2 }));
        await this._page.settle();
    }
    async check(options = {}) { const el = await this._one(); if (!options.force) await this._actionable(el); if (!(el.checked || el.getAttribute('aria-checked') === 'true')) clickElement(el); await this._page.settle(); }
    async uncheck(options = {}) { const el = await this._one(); if (!options.force) await this._actionable(el); if (el.checked || el.getAttribute('aria-checked') === 'true') clickElement(el); await this._page.settle(); }
    async setChecked(checked, options) { return checked ? this.check(options) : this.uncheck(options); }
    async fill(value, options = {}) {
        const el = await this._one();
        if (!options.force) await this._actionable(el);
        const target = editableOf(el);
        target.focus?.();
        const win = target.ownerDocument.defaultView;
        if (target.isContentEditable || target.getAttribute?.('contenteditable') === 'true') target.textContent = value;
        else target.value = value;
        target.dispatchEvent(new win.InputEvent('input', { bubbles: true, composed: true, data: value, inputType: 'insertText' }));
        target.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
        await this._page.settle();
    }
    async clear() { return this.fill(''); }
    async type(text) { return this.pressSequentially(text); }
    async pressSequentially(text) {
        const el = await this._one();
        const target = editableOf(el);
        target.focus?.();
        for (const ch of text) await this._page.keyboard.press(ch, target);
    }
    async press(key) {
        const el = await this._one();
        const target = editableOf(el);
        target.focus?.();
        await this._page.keyboard.press(key, target);
    }
    async selectOption(values, options = {}) {
        const found = await this._one();
        if (!options.force) await this._actionable(found);
        const el = editableOf(found);
        const wanted = (Array.isArray(values) ? values : [values]).map(value => typeof value === 'object' ? (value.value ?? value.label) : value);
        for (const option of el.options || []) option.selected = wanted.includes(option.value) || wanted.includes(normalize(option.textContent));
        const win = el.ownerDocument.defaultView;
        el.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
        await this._page.settle();
        return wanted;
    }
    async setInputFiles(files) {
        const el = editableOf(await this._one());
        const win = el.ownerDocument.defaultView;
        const list = (Array.isArray(files) ? files : [files]).map(file => new win.File([file.buffer], file.name, { type: file.mimeType || '' }));
        Object.defineProperty(el, 'files', { configurable: true, value: Object.assign(list, { item: index => list[index] }) });
        el.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
        await this._page.settle();
    }
    async boundingBox() { throw new Error('boundingBox needs layout: this test belongs in tests/browser'); }
    async screenshot() { throw new Error('screenshots need a browser: this test belongs in tests/browser'); }
    /**
     * Waits until the element can take an action, as Playwright does: it shows, is enabled, and is stable, which
     * Playwright checks over two animation frames. Here that is every component it sits in being defined, then two
     * frames for them to finish drawing.
     */
    async _actionable(el) {
        const deadline = Date.now() + ACTION_TIMEOUT;
        const ready = () => isShown(el) && !isDisabled(el) && everyComponentDefined(el);
        for (; ;) {
            if (ready()) {
                await this._page.settle();
                if (ready()) return;
            }
            if (Date.now() > deadline) {
                throw new Error(`${this._description} is not visible and enabled to click: ${!isShown(el) ? whyHidden(el) : isDisabled(el) ? 'disabled' : 'a component it is in is not defined yet'}`);
            }
            await sleep(INTERVAL);
        }
    }
}

/** Whether the element and every custom element it sits in, across shadow roots, are defined. */
function everyComponentDefined(el) {
    for (let node = el; node; node = node.assignedSlot || node.parentNode || node.host || null) {
        if (node.nodeType === 1 && node.localName.includes('-') && !node.matches(':defined')) return false;
    }
    return true;
}

function isDisabled(el) {
    if (!el) return false;
    if (el.hasAttribute('disabled') && el.getAttribute('disabled') !== 'false') return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    return !!el.closest?.('fieldset[disabled]');
}

/** The field a fill or key press goes to: the element, or the input inside a component that wraps one. */
function editableOf(el) {
    if (['input', 'textarea', 'select'].includes(el.localName) || el.isContentEditable || el.getAttribute?.('contenteditable') === 'true') return el;
    const inner = pierce(el, 'input:not([type="hidden"]), textarea, select, [contenteditable="true"]')[0];
    return inner || el;
}

function clickElement(el, options = {}) {
    const win = el.ownerDocument.defaultView;
    const init = {
        bubbles: true, cancelable: true, composed: true, view: win, detail: options.detail || 1, button: 0,
        ctrlKey: !!options.modifiers?.includes('Control'), shiftKey: !!options.modifiers?.includes('Shift'),
        altKey: !!options.modifiers?.includes('Alt'), metaKey: !!options.modifiers?.includes('Meta'),
    };
    const Pointer = win.PointerEvent || win.MouseEvent;
    el.dispatchEvent(new Pointer('pointerdown', { ...init, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new win.MouseEvent('mousedown', init));
    if (typeof el.focus === 'function' && el.tabIndex >= -1) el.focus();
    el.dispatchEvent(new Pointer('pointerup', { ...init, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new win.MouseEvent('mouseup', init));
    // jsdom runs the activation behavior (a checkbox toggling, a details opening, a label clicking its control) for
    // a dispatched click, as browsers do.
    el.dispatchEvent(new win.MouseEvent('click', init));
}

const KEY_CODES = {
    Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', ' ': 'Space', Space: 'Space',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown',
};

/** The element with focus, looking into shadow roots. */
export function activeElement(document) {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
}

function focusables(document) {
    return pierce(document, 'a[href], button, input, select, textarea, [tabindex], summary, [contenteditable="true"]')
        .filter(el => !isDisabled(el) && isShown(el) && el.tabIndex >= 0 && !el.closest('[inert]'));
}

class Keyboard {
    constructor(page) { this.page = page; }
    async down(key) { this._dispatch('keydown', key); await this.page.settle(); }
    async up(key) { this._dispatch('keyup', key); await this.page.settle(); }
    async type(text) { for (const ch of text) await this.press(ch); }
    async insertText(text) {
        const target = activeElement(this.page.document);
        if (target && 'value' in target) {
            target.value += text;
            target.dispatchEvent(new this.page.window.InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
        }
        await this.page.settle();
    }
    _dispatch(type, combo, target) {
        const win = this.page.window;
        const parts = combo.split('+');
        const key = parts.pop();
        const mods = new Set(parts.map(part => part === 'ControlOrMeta' ? 'Control' : part));
        const el = target || activeElement(this.page.document) || this.page.document.body;
        const event = new win.KeyboardEvent(type, {
            key: key === 'Space' ? ' ' : key, code: KEY_CODES[key] || (key.length === 1 ? `Key${key.toUpperCase()}` : key),
            bubbles: true, cancelable: true, composed: true,
            ctrlKey: mods.has('Control'), shiftKey: mods.has('Shift'), altKey: mods.has('Alt'), metaKey: mods.has('Meta'),
        });
        el.dispatchEvent(event);
        return { el, event, key, mods };
    }
    /** A key press: keydown and keyup, with the browser's default action for keys these components rely on. */
    async press(combo, target) {
        const { el, event, key, mods } = this._dispatch('keydown', combo, target);
        if (!event.defaultPrevented) this._default(el, key, mods);
        this._dispatch('keyup', combo, el.isConnected ? el : target);
        await this.page.settle();
    }
    _default(el, key, mods) {
        const win = this.page.window;
        // A slider moves by its step with the arrow keys, a tenth of its range with Page Up and Down, and to either end
        // with Home and End, sending input and change each time, as browsers do.
        if (el?.localName === 'input' && el.type === 'range') {
            const min = el.min === '' ? 0 : Number(el.min);
            const max = el.max === '' ? 100 : Number(el.max);
            const step = el.step === '' || el.step === 'any' ? 1 : Number(el.step);
            const now = Number(el.value);
            const page = Math.max(step, (max - min) / 10);
            const moves = { ArrowRight: now + step, ArrowUp: now + step, ArrowLeft: now - step, ArrowDown: now - step, PageUp: now + page, PageDown: now - page, Home: min, End: max };
            if (key in moves) {
                const next = Math.min(max, Math.max(min, moves[key]));
                if (next !== now) {
                    el.value = `${next}`;
                    el.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
                    el.dispatchEvent(new win.Event('change', { bubbles: true }));
                }
                return;
            }
        }
        const editable = el && ('value' in el) && (el.localName === 'textarea' || (el.localName === 'input' && !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color'].includes(el.type)));
        if (key.length === 1 && !mods.has('Control') && !mods.has('Meta') && !mods.has('Alt') && editable) {
            el.value += key;
            el.dispatchEvent(new win.InputEvent('input', { bubbles: true, composed: true, data: key, inputType: 'insertText' }));
            return;
        }
        if (key === 'Backspace' && editable) {
            el.value = el.value.slice(0, -1);
            el.dispatchEvent(new win.InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
            return;
        }
        if (key === 'Enter') {
            if (el.localName === 'button' || el.localName === 'a' || el.localName === 'summary' || roleOf(el) === 'button' || roleOf(el) === 'link') { clickElement(el); return; }
            if (el.localName === 'input' && el.form) el.form.requestSubmit?.();
            return;
        }
        if ((key === ' ' || key === 'Space') && (el.localName === 'button' || el.localName === 'summary' || roleOf(el) === 'button' || (el.localName === 'input' && ['checkbox', 'radio'].includes(el.type)))) {
            clickElement(el);
            return;
        }
        if (key === 'Escape') {
            cancelTopModal(win);
            return;
        }
        if (key === 'Tab') {
            const list = focusables(this.page.document);
            const index = list.indexOf(el);
            const next = mods.has('Shift') ? list[index - 1] ?? list[list.length - 1] : list[index + 1] ?? list[0];
            next?.focus();
        }
    }
}

/**
 * Playwright's page.clock on @sinonjs/fake-timers. As in Playwright, time flows on its own after install() (here
 * following real time in steps), until pauseAt() stops it; runFor() and fastForward() move it on at once, and
 * resume() lets it flow again.
 */
class Clock {
    constructor(page) { this.page = page; this._clock = null; this._flow = null; }
    async install(options = {}) {
        this._installOn(this.page.window, options.time ?? Date.now());
        this._startFlow();
    }
    _installOn(window, now) {
        this._clock = FakeTimers.withGlobal(window).install({
            now,
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
            shouldClearNativeTimers: true,
        });
        this.page._fakeClock = this._clock;
    }
    /**
     * A page the tab loads keeps the clock, as in Playwright: called for each new window before its scripts run, it
     * carries on from the time the last page had, flowing or paused as it was.
     */
    _onWindow(window) {
        if (!this._clock) return;
        const now = this._clock.now;
        this._installOn(window, now);
    }
    _startFlow() {
        if (this._flow || !this._clock) return;
        let last = Date.now();
        // Node's own timer, which the fake clock on the page's window does not touch.
        this._flow = setInterval(() => {
            const now = Date.now();
            const step = now - last;
            last = now;
            if (!this._clock || this._busy) return;
            try {
                this._clock.tick(step);
            } catch (error) {
                this.page.env?.errors?.push(`${error?.stack || error}`);
            }
        }, 10);
    }
    _stopFlow() {
        clearInterval(this._flow);
        this._flow = null;
    }
    /** Runs a step that moves the clock itself, without the flow moving it at the same time. */
    async _step(run) {
        this._busy = true;
        try { await run(); } finally { this._busy = false; }
    }
    async runFor(ms) {
        if (!this._clock) await this.install();
        await this._step(() => this._advance(typeof ms === 'string' ? parseDuration(ms) : ms));
    }
    /**
     * Moves time on by `ms`, firing each timer as it comes due, with the page's promises settled after each, as
     * Playwright's runFor does. fake-timers' tickAsync waits a real timeout after each timer, which a busy test worker
     * stretches, and a few seconds of animation frames took longer than a test may.
     */
    async _advance(ms) {
        const clock = this._clock;
        const end = clock.now + ms;
        for (; ;) {
            const due = Object.values(clock.timers || {}).reduce((first, timer) => Math.min(first, timer.callAt), Infinity);
            if (due > end) break;
            clock.next();
            await new Promise(resolve => setImmediate(resolve));
            if (this._clock !== clock) return;
        }
        if (clock.now < end) clock.tick(end - clock.now);
        await new Promise(resolve => setImmediate(resolve));
    }
    /** Jumps ahead, firing each timer that comes due at most once, as Playwright's fastForward does. */
    async fastForward(ms) {
        if (!this._clock) await this.install();
        await this._step(async () => {
            this._clock.jump(typeof ms === 'string' ? parseDuration(ms) : ms);
            await this.page.settle();
        });
    }
    /** Moves to the time and stops there: nothing fires again until the test moves the clock. */
    async pauseAt(time) {
        if (!this._clock) await this.install({ time: 0 });
        this._stopFlow();
        const target = new Date(time).getTime();
        if (target > this._clock.now) await this.fastForward(target - this._clock.now);
        else this._clock.setSystemTime(target);
    }
    async setFixedTime(time) {
        if (!this._clock) await this.install();
        this._clock.setSystemTime(new Date(time).getTime());
    }
    async setSystemTime(time) { return this.setFixedTime(time); }
    async resume() { this._startFlow(); }
    uninstall() { this._stopFlow(); this._clock?.uninstall(); this._clock = null; this.page._fakeClock = null; }
}

function parseDuration(text) {
    const parts = `${text}`.split(':').map(Number);
    return parts.reduce((total, part) => total * 60 + part, 0) * 1000;
}

/** The page object a component test uses: its window, locators, evaluate, keyboard and clock. */
export class Page {
    constructor(env) {
        this._attach(env);
        this.keyboard = new Keyboard(this);
        this.clock = new Clock(this);
        this.mouse = new Proxy({}, { get() { throw new Error('page.mouse needs layout: this test belongs in tests/browser'); } });
    }
    /** Points the page at the env's current window, after the env loads a page again. */
    _attach(env) {
        this.env = env;
        this.window = env.window;
        this.document = env.window?.document;
    }
    /** Lets go of the window, once the test is over, so it can be freed. */
    release() {
        this.env = null;
        this.window = null;
        this.document = null;
        this.clock = null;
        this.keyboard = null;
        for (const key of Object.keys(this)) if (key.startsWith('__')) delete this[key];
    }
    get root() { return new Locator(this, () => [this.document], 'page'); }
    async reload() { await this.env.reload(); }
    async goto(url) { await this.env.goto(url); }
    async goBack() { this.window.history.back(); await this.settle(); }
    async goForward() { this.window.history.forward(); await this.settle(); }
    /** Adds a script to the page, from its content, a file path, or an address the page can load. */
    async addScriptTag({ content, path, url } = {}) {
        const { readFileSync } = await import('node:fs');
        let code = content;
        if (path) {
            this.env.record?.(path);
            code = readFileSync(path, 'utf8');
        }
        if (url) code = await (await this.window.fetch(url)).text();
        this.window.eval(code);
        await this.settle();
    }
    locator(selector, options) { return this.root.locator(selector, options); }
    /** The document of the iframe the selector finds, as Playwright's frameLocator. */
    frameLocator(selector) { return this.locator(selector).first().contentFrame(); }
    getByRole(role, options) { return this.root.getByRole(role, options); }
    getByText(text, options) { return this.root.getByText(text, options); }
    getByLabel(text, options) { return this.root.getByLabel(text, options); }
    getByTitle(text, options) { return this.root.getByTitle(text, options); }
    getByPlaceholder(text, options) { return this.root.getByPlaceholder(text, options); }
    /** Runs `fn` in the page, where `webui` and the page's own globals are, as page.evaluate does. */
    async evaluate(fn, arg) { return this._call(fn, undefined, arg, true); }
    async _call(fn, element, arg, pageLevel = false) {
        const source = typeof fn === 'function' ? fn.toString() : `() => (${fn})`;
        const compiled = this.window.eval(`(${source})`);
        const pageArg = this._inPage(arg);
        const result = pageLevel ? compiled(pageArg) : compiled(element, pageArg);
        const value = await result;
        await this.settle();
        return value;
    }
    /**
     * An argument as the page gets it: Playwright serializes it into the page, so arrays and objects are the page's own
     * and `instanceof Array` holds there. Anything that cannot be cloned is passed as it is.
     */
    _inPage(arg) {
        if (arg === null || typeof arg !== 'object') return arg;
        try {
            return this.window.structuredClone(arg);
        } catch {
            return arg;
        }
    }
    async waitForFunction(fn, arg, options = {}) {
        const timeout = options.timeout ?? ACTION_TIMEOUT;
        const source = typeof fn === 'function' ? fn.toString() : `() => (${fn})`;
        // Compiled in the window showing when it is checked, since the page can load again while this waits.
        let compiled, compiledFor;
        const deadline = Date.now() + timeout;
        for (; ;) {
            if (compiledFor !== this.window) {
                compiled = this.window.eval(`(${source})`);
                compiledFor = this.window;
            }
            const value = await compiled(this._inPage(arg));
            if (value) return value;
            if (Date.now() > deadline) throw new Error(`waitForFunction timed out: ${source}`);
            await sleep(INTERVAL);
        }
    }
    async waitForTimeout() { throw new Error('No waiting on time: wait for what the page does instead'); }
    /** Waits for an element matching the selector to show (or, with state, to be attached, hidden or detached). */
    async waitForSelector(selector, { state = 'visible', timeout = ACTION_TIMEOUT } = {}) {
        const deadline = Date.now() + timeout;
        for (; ;) {
            const found = this.locator(selector).elements();
            const done = state === 'attached' ? found.length > 0
                : state === 'detached' ? found.length === 0
                    : state === 'hidden' ? found.every(el => !isShown(el))
                        : found.some(el => isShown(el));
            if (done) return found[0] ?? null;
            if (Date.now() > deadline) throw new Error(`waitForSelector timed out: ${selector} (${state})`);
            await sleep(INTERVAL);
        }
    }
    /**
     * Runs a script in every page this tab loads from now on, before the page's own scripts, as Playwright's does.
     * Takes a function (with an argument), { content }, or { path }.
     */
    async addInitScript(script, arg) {
        let source;
        if (typeof script === 'function') source = script.toString();
        else if (typeof script === 'string') source = `() => { ${script} }`;
        else if (script?.content) source = `() => { ${script.content} }`;
        else if (script?.path) {
            const { readFileSync } = await import('node:fs');
            this.env.record?.(script.path);
            source = `() => { ${readFileSync(script.path, 'utf8')} }`;
        }
        this.env.initScripts.push({ source, arg });
    }
    /** Gives every page this tab loads a function that runs in Node, as Playwright's exposeFunction does. */
    async exposeFunction(name, fn) {
        this.env.exposed[name] = fn;
        this.window[name] = async (...args) => fn(...args);
    }
    /** Sets what CSS media queries see, as Playwright's emulateMedia does, for matchMedia here and in later pages. */
    async emulateMedia(options = {}) {
        this.env.media = { ...(this.env.media || {}), ...options };
        this.window.matchMedia = mediaMatcher(this.env.media);
        await this.settle();
    }
    /** Lets the page act on what just happened. With a fake clock, nothing moves on until the test moves it. */
    async settle() {
        if (this._fakeClock) {
            // While the fake clock flows, two frames pass in about 35 ms of real time. Paused, nothing moves on.
            if (this.clock?._flow) await sleep(35);
            else await Promise.resolve();
            return;
        }
        await this.env.settle();
    }
    /** Sets the window's size and sends resize. Nothing is laid out: a test that checks what fits belongs in tests/browser. */
    async setViewportSize({ width, height }) {
        Object.defineProperty(this.window, 'innerWidth', { configurable: true, value: width });
        Object.defineProperty(this.window, 'innerHeight', { configurable: true, value: height });
        this.window.dispatchEvent(new this.window.Event('resize'));
        await this.settle();
    }
    viewportSize() { return { width: this.window.innerWidth, height: this.window.innerHeight }; }
    route(pattern, handler) { return this.env.route(pattern, handler); }
    on(event, listener) { return this.env.on(event, listener); }
    async waitForEvent(event, predicate) { return this.env.waitForEvent(event, predicate); }
    url() { return this.window.location.href; }
}

/**
 * Vitest's expect with its own expect.poll, which retries the assertion until it passes, as Playwright's does. Vitest's
 * needs to know which test is running, which it cannot tell while a file's tests run at the same time.
 */
export const pageExpect = new Proxy(expect, {
    get(target, prop, receiver) {
        if (prop === 'poll') return poll;
        return Reflect.get(target, prop, receiver);
    },
});

function poll(fn, { timeout = TIMEOUT, interval = 20, message } = {}) {
    const assertions = negated => new Proxy({}, {
        get(_, name) {
            if (name === 'not') return assertions(!negated);
            if (name === 'then') return undefined;
            return async (...args) => {
                const deadline = Date.now() + timeout;
                for (; ;) {
                    let value;
                    try {
                        value = await fn();
                        const assertion = negated ? expect(value, message).not : expect(value, message);
                        await assertion[name](...args);
                        return;
                    } catch (error) {
                        if (Date.now() > deadline) {
                            error.message = `${error.message}\n(expect.poll gave up after ${timeout} ms)`;
                            throw error;
                        }
                    }
                    await sleep(interval);
                }
            };
        },
    });
    return assertions(false);
}

function matcher(name, run) {
    return async function (received, ...args) {
        const last = args[args.length - 1];
        const options = last && typeof last === 'object' && !(last instanceof RegExp) && !Array.isArray(last) ? last : {};
        // Vitest leaves isNot undefined, not false, on an assertion without .not.
        const isNot = !!this.isNot;
        const deadline = Date.now() + (options.timeout ?? TIMEOUT);
        let result;
        for (; ;) {
            result = await run(received, ...args);
            if (!!result.pass !== isNot) break;
            if (Date.now() > deadline) break;
            await sleep(INTERVAL);
        }
        return { pass: !!result.pass, message: () => `${received} ${isNot ? 'not.' : ''}${name}: ${result.message}` };
    };
}

const textOfLocator = el => normalize(renderedText(el));
const sameText = (actual, expected, contains) => expected instanceof RegExp ? expected.test(actual) : contains ? actual.includes(normalize(expected)) : actual === normalize(expected);

function textMatcher(contains) {
    return (locator, expected) => {
        if (Array.isArray(expected)) {
            const actual = locator.elements().map(textOfLocator);
            const pass = actual.length === expected.length && expected.every((want, i) => sameText(actual[i], want, contains));
            return { pass, message: `expected ${JSON.stringify(expected.map(String))}, got ${JSON.stringify(actual)}` };
        }
        const el = locator.element();
        const actual = el ? textOfLocator(el) : null;
        return { pass: actual !== null && sameText(actual, expected, contains), message: `expected ${expected}, got ${JSON.stringify(actual)}` };
    };
}

expect.extend({
    toBeVisible: matcher('toBeVisible', locator => {
        const el = locator.element();
        return { pass: !!el && isShown(el), message: el ? `element is hidden (${whyHidden(el)})` : 'no element' };
    }),
    toBeHidden: matcher('toBeHidden', locator => {
        const el = locator.element();
        return { pass: !el || !isShown(el), message: 'element shows' };
    }),
    toBeAttached: matcher('toBeAttached', locator => ({ pass: !!locator.element()?.isConnected, message: 'no element' })),
    toHaveText: matcher('toHaveText', textMatcher(false)),
    toContainText: matcher('toContainText', textMatcher(true)),
    toHaveAttribute: matcher('toHaveAttribute', (locator, name, value) => {
        const el = locator.element();
        if (!el) return { pass: false, message: 'no element' };
        const actual = el.getAttribute(name);
        if (value === undefined || (typeof value === 'object' && !(value instanceof RegExp))) return { pass: actual !== null, message: `attribute ${name} is ${actual}` };
        const pass = actual !== null && (value instanceof RegExp ? value.test(actual) : actual === `${value}`);
        return { pass, message: `attribute ${name} is ${JSON.stringify(actual)}, expected ${value}` };
    }),
    toHaveCount: matcher('toHaveCount', (locator, count) => {
        const actual = locator.elements().length;
        return { pass: actual === count, message: `count is ${actual}, expected ${count}` };
    }),
    toHaveClass: matcher('toHaveClass', (locator, expected) => {
        const el = locator.element();
        const actual = el?.getAttribute('class') ?? '';
        const pass = !!el && (expected instanceof RegExp ? expected.test(actual) : normalize(actual) === normalize(expected));
        return { pass, message: `class is ${JSON.stringify(actual)}` };
    }),
    toContainClass: matcher('toContainClass', (locator, expected) => {
        const el = locator.element();
        const pass = !!el && `${expected}`.split(/\s+/).every(name => el.classList.contains(name));
        return { pass, message: `class is ${JSON.stringify(el?.className)}` };
    }),
    toHaveValue: matcher('toHaveValue', (locator, expected) => {
        const el = locator.element();
        const actual = el ? `${editableOf(el).value ?? el.value ?? ''}` : null;
        const pass = actual !== null && (expected instanceof RegExp ? expected.test(actual) : actual === `${expected}`);
        return { pass, message: `value is ${JSON.stringify(actual)}` };
    }),
    toBeChecked: matcher('toBeChecked', (locator, options = {}) => {
        const el = locator.element();
        const checked = !!el && (el.checked === true || el.getAttribute('aria-checked') === 'true' || editableOf(el).checked === true);
        const want = options.checked ?? true;
        return { pass: !!el && checked === want, message: `checked is ${checked}` };
    }),
    toBeDisabled: matcher('toBeDisabled', locator => ({ pass: isDisabled(locator.element()), message: 'element is enabled' })),
    toBeEnabled: matcher('toBeEnabled', locator => ({ pass: !!locator.element() && !isDisabled(locator.element()), message: 'element is disabled' })),
    // Editable, as Playwright's: enabled, not read-only, and a field or contenteditable.
    toBeEditable: matcher('toBeEditable', locator => {
        const el = locator.element();
        if (!el) return { pass: false, message: 'no element' };
        const field = ['input', 'textarea', 'select'].includes(el.localName) || el.isContentEditable || el.getAttribute('contenteditable') === 'true' || ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(roleOf(el));
        const readOnly = el.readOnly || el.hasAttribute('readonly') || el.getAttribute('aria-readonly') === 'true';
        return { pass: field && !isDisabled(el) && !readOnly, message: !field ? 'element is not a field' : isDisabled(el) ? 'element is disabled' : 'element is read-only' };
    }),
    toBeFocused: matcher('toBeFocused', locator => {
        const el = locator.element();
        const doc = el?.ownerDocument;
        let active = doc?.activeElement;
        const chain = [];
        while (active) {
            chain.push(active);
            active = active.shadowRoot?.activeElement;
        }
        return { pass: !!el && chain.includes(el), message: `focus is on ${chain.map(node => node.localName).join(' > ')}` };
    }),
    toHaveJSProperty: matcher('toHaveJSProperty', (locator, name, value) => {
        const el = locator.element();
        return { pass: !!el && JSON.stringify(el[name]) === JSON.stringify(value), message: `${name} is ${JSON.stringify(el?.[name])}` };
    }),
    toHaveId: matcher('toHaveId', (locator, id) => ({ pass: locator.element()?.id === id, message: `id is ${locator.element()?.id}` })),
    toHaveURL: matcher('toHaveURL', (page, expected) => {
        const actual = page.window.location.href;
        const pass = typeof expected === 'function' ? !!expected(new URL(actual))
            : expected instanceof RegExp ? expected.test(actual) : actual === new URL(expected, page.window.location.href).href;
        return { pass, message: `url is ${actual}` };
    }),
    toHaveTitle: matcher('toHaveTitle', (page, expected) => {
        const actual = page.document.title;
        return { pass: expected instanceof RegExp ? expected.test(actual) : actual === expected, message: `title is ${actual}` };
    }),
    toHaveAccessibleName: matcher('toHaveAccessibleName', (locator, expected) => {
        const actual = nameOf(locator.element());
        return { pass: expected instanceof RegExp ? expected.test(actual) : actual === normalize(expected), message: `name is ${actual}` };
    }),
});
