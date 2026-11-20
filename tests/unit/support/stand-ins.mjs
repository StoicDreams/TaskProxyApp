import { createRequire } from 'node:module';
import vm from 'node:vm';

// jsdom's link from the page's objects to its own, used only to mark the events a browser would send as trusted.
const idl = createRequire(import.meta.url)('jsdom/lib/generated/idl/utils.js');
// Browser APIs jsdom does not have, with the smallest stand-ins that keep components working. They never invent
// layout: observers report nothing changing size, and an element observed for visibility is in view while it shows.

/**
 * Whether an element shows, as far as can be told without layout: neither it nor anything it sits in (across shadow
 * roots and slots) is hidden, display:none, visibility:hidden, a closed dialog, or a closed popover.
 */
export function isShown(element) {
    if (!element || !element.isConnected) return false;
    let node = element;
    while (node) {
        if (node.nodeType === 1) {
            if (node.hidden || node.hasAttribute('hidden')) return false;
            // A hidden tab's content has no height, which Playwright counts as hidden, but what is in it keeps its size.
            if (node === element && node.hasAttribute('tab-hidden')) return false;
            const view = node.ownerDocument.defaultView;
            const style = view.getComputedStyle(node);
            // jsdom's own stylesheet hides every popover, open or not, so an open one is judged by its inline style only.
            const display = node.hasAttribute('popover') ? node.style?.display : style.display;
            if (node.style?.display === 'none' || display === 'none' || style.visibility === 'hidden') return false;
            if (node.localName === 'dialog' && !node.hasAttribute('open')) return false;
            if (node.hasAttribute('popover') && !node.__popoverOpen) return false;
            // A slot's own content is only a fallback, not shown while something is assigned to the slot.
            const parent = node.parentNode;
            if (parent?.localName === 'slot' && parent.assignedNodes?.().length) return false;
            if (node.parentNode?.shadowRoot && !node.assignedSlot) {
                const slots = [...node.parentNode.shadowRoot.querySelectorAll('slot')];
                const wanted = node.getAttribute('slot') || '';
                if (!slots.some(slot => (slot.getAttribute('name') || '') === wanted)) return false;
            }
        }
        node = node.assignedSlot || node.parentNode || node.host || null;
    }
    return true;
}

/**
 * matchMedia for the media a test emulates ({ colorScheme, reducedMotion, forcedColors, contrast }): a query for one of
 * those matches its value, and every other query matches nothing, as there is no screen.
 */
export function mediaMatcher(media = {}) {
    const want = (query, name, value) => value && new RegExp(`\\(\\s*${name}\\s*:\\s*${value}\\s*\\)`).test(query);
    const matches = query => !!(want(query, 'prefers-color-scheme', media.colorScheme) || want(query, 'prefers-reduced-motion', media.reducedMotion)
        || want(query, 'forced-colors', media.forcedColors) || want(query, 'prefers-contrast', media.contrast));
    return query => ({
        matches: matches(query), media: query, onchange: null,
        addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { }, dispatchEvent() { return false; },
    });
}

/** Escape's default action: the top modal dialog gets a cancel event, and closes unless that is prevented. */
export function cancelTopModal(window) {
    const top = (window.__openModals || []).filter(open => open.isConnected && open.hasAttribute('open')).at(-1);
    if (!top) return false;
    const cancel = new window.Event('cancel', { cancelable: true });
    top.dispatchEvent(cancel);
    if (!cancel.defaultPrevented) top.close();
    return true;
}

/** Why isShown says an element does not show: the first element on its way up that hides it, and how. */
export function whyHidden(element) {
    if (!element?.isConnected) return 'not in the page';
    let node = element;
    const name = el => `${el.localName}${el.id ? `#${el.id}` : ''}${el.classList?.length ? `.${[...el.classList].join('.')}` : ''}`;
    while (node) {
        if (node.nodeType === 1) {
            if (node.hidden || node.hasAttribute('hidden')) return `${name(node)} is hidden`;
            if (node === element && node.hasAttribute('tab-hidden')) return `${name(node)} has tab-hidden`;
            const style = node.ownerDocument.defaultView.getComputedStyle(node);
            const display = node.hasAttribute('popover') ? node.style?.display : style.display;
            if (node.style?.display === 'none' || display === 'none') return `${name(node)} has display none`;
            if (style.visibility === 'hidden') return `${name(node)} has visibility hidden`;
            if (node.localName === 'dialog' && !node.hasAttribute('open')) return `${name(node)} is a closed dialog`;
            if (node.hasAttribute('popover') && !node.__popoverOpen) return `${name(node)} is a closed popover`;
            const parent = node.parentNode;
            if (parent?.localName === 'slot' && parent.assignedNodes?.().length) return `${name(node)} is a slot fallback`;
            if (node.parentNode?.shadowRoot && !node.assignedSlot) {
                const slots = [...node.parentNode.shadowRoot.querySelectorAll('slot')];
                const wanted = node.getAttribute('slot') || '';
                if (!slots.some(slot => (slot.getAttribute('name') || '') === wanted)) return `${name(node)} has no slot named "${wanted}"`;
            }
        }
        node = node.assignedSlot || node.parentNode || node.host || null;
    }
    return 'shown';
}

/** Whether a form-associated element is disabled, by its own attribute or a disabled fieldset around it. */
function formDisabled(el) {
    if (el.hasAttribute('disabled')) return true;
    const fieldset = el.closest('fieldset[disabled]');
    if (!fieldset) return false;
    const legend = fieldset.querySelector(':scope > legend');
    return !(legend && legend.contains(el));
}

/** Installs the stand-ins on a jsdom window, before its scripts run. */
export function installStandIns(window) {
    // Web Workers: the worker's script runs in its own Node context, with messages passed both ways as a browser does,
    // copied and asynchronous.
    window.Worker ??= class Worker extends window.EventTarget {
        constructor(url) {
            super();
            this.onmessage = null;
            this.onerror = null;
            this._queue = [];
            const href = new window.URL(url, window.location.href).href;
            const scope = {
                console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, structuredClone, TextEncoder, TextDecoder,
                URL, Blob, fetch: (...args) => window.fetch(...args), crypto: globalThis.crypto,
                postMessage: data => setTimeout(() => {
                    if (this._terminated) return;
                    // A message from a worker is trusted, as the browser sends it, and apps check that.
                    const event = new window.MessageEvent('message', { data: window.structuredClone(data) });
                    const eventImpl = idl.implForWrapper(event);
                    eventImpl.isTrusted = true;
                    this.onmessage?.(event);
                    idl.implForWrapper(this)._dispatch(eventImpl);
                }, 0),
                close: () => this.terminate(),
                // A worker's script sets these as globals, which strict mode allows only for names that exist.
                onmessage: null,
                onerror: null,
            };
            scope.self = scope;
            scope.globalThis = scope;
            this._context = vm.createContext(scope);
            this._ready = window.fetch(href).then(response => response.text()).then(code => {
                vm.runInContext(code, this._context, { filename: href });
                this._started = true;
                this._queue.splice(0).forEach(data => this._deliver(data));
            }).catch(error => {
                const event = new window.ErrorEvent('error', { message: `${error.message}`, error });
                this.onerror?.(event);
                this.dispatchEvent(event);
            });
        }
        _deliver(data) {
            setTimeout(() => {
                if (this._terminated) return;
                const handler = this._context.onmessage;
                if (typeof handler === 'function') handler({ data: structuredClone(data), isTrusted: true });
            }, 0);
        }
        postMessage(data) {
            if (this._terminated) return;
            if (this._started) this._deliver(data);
            else this._queue.push(data);
        }
        terminate() { this._terminated = true; }
    };
    // structuredClone made in the page's realm: Node's makes Node objects and drops jsdom's Blob and File.
    window.structuredClone = value => cloneInto(window, value, new Map());
    // The site's index.html registers its service worker; the worker itself is tested in Node (service-worker test).
    if (!window.navigator.serviceWorker) {
        const registration = { update: async () => {}, unregister: async () => true, addEventListener() {}, removeEventListener() {} };
        Object.defineProperty(window.navigator, 'serviceWorker', {
            configurable: true,
            value: { register: async () => registration, ready: Promise.resolve(registration), controller: null, addEventListener() {}, removeEventListener() {}, getRegistrations: async () => [] },
        });
    }
    // jsdom's DOM methods are Node functions, not the page's, so `el.matches instanceof Function` was false in the page.
    Object.defineProperty(window.Function, Symbol.hasInstance, { configurable: true, value: value => typeof value === 'function' });
    // Layout-free visibility: an element that shows has one box, which is all code checking getClientRects or
    // offsetParent wants to know. Sizes stay 0.
    const elementProto = window.Element.prototype;
    const nativeRects = elementProto.getClientRects;
    elementProto.getClientRects = function () {
        const rects = nativeRects.call(this);
        if (rects.length || !isShown(this)) return rects;
        const rect = this.getBoundingClientRect();
        return Object.assign([rect], { item: index => (index === 0 ? rect : null) });
    };
    // A 2D canvas context that draws nothing: what is drawn is checked in tests/browser. Text measures 8px a letter.
    const canvasProto = window.HTMLCanvasElement.prototype;
    const getContext = canvasProto.getContext;
    canvasProto.getContext = function (type, ...rest) {
        if (type !== '2d') return getContext.call(this, type, ...rest);
        this.__context2d ??= new Proxy({ canvas: this, measureText: text => ({ width: `${text}`.length * 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
            getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) }),
            createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) }),
            createLinearGradient: () => ({ addColorStop() { } }), createRadialGradient: () => ({ addColorStop() { } }), createPattern: () => ({}),
            getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), getLineDash: () => [], isPointInPath: () => false, isPointInStroke: () => false,
        }, {
            // Every other method does nothing, and every property can be set and read back.
            get: (target, key) => key in target ? target[key] : (typeof key === 'string' && !/^(font|fillStyle|strokeStyle|lineWidth|globalAlpha|textAlign|textBaseline|lineCap|lineJoin|globalCompositeOperation|shadow\w*|imageSmoothing\w*|direction|filter|miterLimit|lineDashOffset)$/.test(key) ? () => { } : undefined),
            set: (target, key, value) => { target[key] = value; return true; },
        });
        return this.__context2d;
    };
    canvasProto.toDataURL = function () { return 'data:image/png;base64,'; };
    canvasProto.toBlob = function (callback) { setTimeout(() => callback(new window.Blob([], { type: 'image/png' })), 0); };
    // Nothing has a position, so nothing is found at a point.
    window.document.elementsFromPoint ??= () => [];
    window.document.elementFromPoint ??= () => null;
    elementProto.checkVisibility ??= function () { return isShown(this); };
    // innerText: jsdom has none, so setting it did nothing. Setting it replaces the content with the text, each line
    // break a <br>, as browsers do; reading it gives the text with <br> as a line break.
    if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerText')) {
        Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
            configurable: true,
            get() {
                const read = node => node.nodeType === 3 ? node.data
                    : node.localName === 'br' ? '\n'
                        : ['style', 'script', 'template'].includes(node.localName) ? ''
                            : [...node.childNodes].map(read).join('');
                return read(this);
            },
            set(value) {
                const lines = `${value ?? ''}`.split(/\r\n|\n|\r/);
                this.replaceChildren();
                lines.forEach((line, index) => {
                    if (index) this.appendChild(this.ownerDocument.createElement('br'));
                    if (line) this.appendChild(this.ownerDocument.createTextNode(line));
                });
            },
        });
    }
    Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
        configurable: true,
        get() { return isShown(this) && this.localName !== 'body' ? (this.parentElement || this.getRootNode().host || this.ownerDocument.body) : null; },
    });
    // Form-associated custom elements: what they report with setFormValue is in the form's data, a form reset calls
    // formResetCallback, and disabling them or a fieldset around them calls formDisabledCallback, as browsers do.
    const NativeFormData = window.FormData;
    window.FormData = class FormData extends NativeFormData {
        constructor(form, submitter) {
            super(form, submitter);
            if (!form) return;
            for (const el of form.querySelectorAll('*')) {
                if (!el.constructor?.formAssociated || el.__formValue === undefined || el.__formValue === null) continue;
                const name = el.getAttribute('name');
                if (!name || formDisabled(el)) continue;
                if (el.__formValue instanceof NativeFormData) {
                    for (const [key, value] of el.__formValue) this.append(key, value);
                } else {
                    this.append(name, el.__formValue);
                }
            }
        }
    };
    window.document.addEventListener('reset', event => {
        const form = event.target;
        queueMicrotask(() => {
            if (event.defaultPrevented) return;
            for (const el of form.querySelectorAll('*')) if (el.constructor?.formAssociated) el.formResetCallback?.();
        });
    }, true);
    const checkDisabled = root => {
        for (const el of [root, ...root.querySelectorAll('*')]) {
            if (!el.constructor?.formAssociated) continue;
            const disabled = formDisabled(el);
            if (el.__formDisabled === disabled) continue;
            const before = el.__formDisabled;
            el.__formDisabled = disabled;
            if (before !== undefined || disabled) el.formDisabledCallback?.(disabled);
        }
    };
    new window.MutationObserver(records => {
        for (const record of records) if (record.target.nodeType === 1) checkDisabled(record.target);
    }).observe(window.document, { attributes: true, attributeFilter: ['disabled'], subtree: true });
    window.ResizeObserver ??= class ResizeObserver {
        constructor(callback) { this.callback = callback; }
        observe() { }
        unobserve() { }
        disconnect() { }
    };
    // An element is in view while it shows (isShown), since nothing has a position: hidden content stays unloaded, as
    // in a browser, and what shows loads. Each observer reports every element when observed, then each change, checked
    // every 50 ms on Node's own timer, which a test's fake clock does not stop.
    const observers = new Set();
    let watch = null;
    const check = () => {
        if (!window.document?.defaultView) {
            clearInterval(watch);
            watch = null;
            return;
        }
        for (const observer of observers) observer._check();
    };
    window.IntersectionObserver ??= class IntersectionObserver {
        constructor(callback, options = {}) {
            this.callback = callback;
            this.root = options.root || null;
            this.rootMargin = options.rootMargin || '0px';
            this.thresholds = [].concat(options.threshold ?? 0);
            this.targets = new Map();
        }
        _entry(target, shown) {
            const rect = target.getBoundingClientRect();
            return { target, isIntersecting: shown, intersectionRatio: shown ? 1 : 0, time: window.performance.now(), boundingClientRect: rect, intersectionRect: rect, rootBounds: null, isVisible: shown };
        }
        _check() {
            const entries = [];
            for (const [target, last] of this.targets) {
                const shown = isShown(target);
                if (shown === last) continue;
                this.targets.set(target, shown);
                entries.push(this._entry(target, shown));
            }
            if (entries.length) this.callback(entries, this);
        }
        observe(target) {
            if (this.targets.has(target)) return;
            // undefined: not reported yet, so the first check reports it whether it shows or not.
            this.targets.set(target, undefined);
            observers.add(this);
            watch ??= setInterval(check, 50);
            setTimeout(() => {
                if (!this.targets.has(target) || this.targets.get(target) !== undefined) return;
                const shown = isShown(target);
                this.targets.set(target, shown);
                this.callback([this._entry(target, shown)], this);
            }, 0);
        }
        unobserve(target) { this.targets.delete(target); }
        disconnect() {
            this.targets.clear();
            observers.delete(this);
        }
        takeRecords() { return []; }
    };
    window.URL.createObjectURL ??= (() => { let next = 0; return () => `blob:${window.location.origin}/object-${++next}`; })();
    window.URL.revokeObjectURL ??= () => { };
    const proto = window.Element.prototype;
    proto.scrollIntoView ??= function () { };
    proto.scrollTo ??= function () { };
    proto.scrollBy ??= function () { };
    window.scrollTo = () => { };
    window.scrollBy = () => { };
    proto.getAnimations ??= function () { return []; };
    // Animations finish at once: there is no time passing in a test's layout-free page.
    proto.animate ??= function () {
        const animation = {
            playState: 'finished', currentTime: 0, effect: null, onfinish: null, oncancel: null,
            finished: Promise.resolve(), cancel() { }, finish() { }, play() { }, pause() { }, reverse() { }, commitStyles() { },
            addEventListener(type, listener) { if (type === 'finish') window.setTimeout(() => listener({ type }), 0); }, removeEventListener() { },
        };
        animation.finished = Promise.resolve(animation);
        window.setTimeout(() => animation.onfinish?.({ type: 'finish' }), 0);
        return animation;
    };
    // <dialog>: open, close, and the close event, with forms in it using method="dialog" closing it.
    const dialog = window.HTMLDialogElement?.prototype;
    if (dialog) {
        dialog.show ??= function () { this.setAttribute('open', ''); };
        // Modal dialogs in the order they opened, so Escape cancels the top one (cancelTopModal).
        window.__openModals = [];
        dialog.showModal ??= function () {
            this.setAttribute('open', '');
            this.__modal = true;
            window.__openModals.push(this);
        };
        dialog.close ??= function (value) {
            if (!this.hasAttribute('open')) return;
            if (value !== undefined) this.returnValue = `${value}`;
            this.removeAttribute('open');
            this.__modal = false;
            window.__openModals = window.__openModals.filter(open => open !== this);
            this.dispatchEvent(new window.Event('close'));
        };
        if (!('returnValue' in dialog)) {
            Object.defineProperty(dialog, 'returnValue', { configurable: true, get() { return this.__returnValue ?? ''; }, set(value) { this.__returnValue = `${value}`; } });
        }
        if (!('open' in dialog)) {
            Object.defineProperty(dialog, 'open', { configurable: true, get() { return this.hasAttribute('open'); }, set(value) { this.toggleAttribute('open', !!value); } });
        }
        window.document.addEventListener('submit', event => {
            const form = event.target;
            const method = (event.submitter?.getAttribute('formmethod') || form.getAttribute?.('method') || '').toLowerCase();
            if (method !== 'dialog' || event.defaultPrevented) return;
            event.preventDefault();
            form.closest('dialog')?.close(event.submitter?.value);
        });
    }
    // Popovers: shown and hidden by state, with the toggle events components listen for.
    const html = window.HTMLElement.prototype;
    if (!html.showPopover) {
        const toggle = (el, open) => {
            const was = !!el.__popoverOpen;
            if (was === open) return;
            el.dispatchEvent(new window.Event('beforetoggle'));
            el.__popoverOpen = open;
            const event = new window.Event('toggle');
            event.newState = open ? 'open' : 'closed';
            event.oldState = was ? 'open' : 'closed';
            el.dispatchEvent(event);
        };
        html.showPopover = function () { toggle(this, true); };
        html.hidePopover = function () { toggle(this, false); };
        html.togglePopover = function (force) { toggle(this, force ?? !this.__popoverOpen); return !!this.__popoverOpen; };
        const matches = window.Element.prototype.matches;
        window.Element.prototype.matches = function (selector) {
            if (selector === ':popover-open') return !!this.__popoverOpen;
            return matches.call(this, selector);
        };
    }
    // The clipboard keeps what is written, so tests can read it back.
    if (!window.navigator.clipboard) {
        let text = '';
        let items = [];
        Object.defineProperty(window.navigator, 'clipboard', {
            configurable: true,
            value: {
                writeText: async value => { text = `${value}`; },
                readText: async () => text,
                write: async value => { items = value; },
                read: async () => items,
            },
        });
    }
    window.ClipboardItem ??= class ClipboardItem {
        constructor(items) { this.items = items; this.types = Object.keys(items); }
        async getType(type) { return this.items[type]; }
    };
    window.DataTransfer ??= class DataTransfer {
        constructor() { this.data = {}; this.files = []; this.items = { add: file => { this.files.push(file); } }; this.dropEffect = 'none'; this.effectAllowed = 'all'; }
        setData(type, value) { this.data[type] = `${value}`; }
        getData(type) { return this.data[type] ?? ''; }
        clearData() { this.data = {}; }
        // Dragged files show as 'Files', as in a browser.
        get types() { return [...Object.keys(this.data), ...(this.files.length ? ['Files'] : [])]; }
    };
    // A drag event carries its DataTransfer, as a browser's does.
    window.DragEvent ??= class DragEvent extends window.MouseEvent {
        constructor(type, init = {}) {
            super(type, init);
            Object.defineProperty(this, 'dataTransfer', { configurable: true, value: init.dataTransfer ?? null });
        }
    };
}

/**
 * A fetch response made for the page from Node's: the same status, headers and body, with json() parsed by the page's
 * own JSON, so the objects it returns are the page's and `instanceof Object` or `Array` holds there.
 */
export function pageResponse(window, response) {
    let bodyUsed = false;
    const read = async () => {
        bodyUsed = true;
        return Buffer.from(await response.arrayBuffer());
    };
    const wrapped = {
        ok: response.ok, status: response.status, statusText: response.statusText, url: response.url,
        redirected: response.redirected, type: response.type, headers: response.headers,
        get bodyUsed() { return bodyUsed; },
        // Decoded as a browser does, which drops a byte order mark at the start.
        async text() { return new TextDecoder().decode(await read()); },
        async json() { return window.JSON.parse(new TextDecoder().decode(await read())); },
        async arrayBuffer() { const bytes = await read(); return new window.Uint8Array(bytes).buffer; },
        async blob() { const bytes = await read(); return new window.Blob([new window.Uint8Array(bytes)], { type: response.headers.get('content-type') || '' }); },
        async formData() { return response.formData(); },
        clone() { return pageResponse(window, response.clone()); },
        get body() { return response.body; },
    };
    return wrapped;
}

/** The structured clone algorithm, enough for page data: the copy is made of the window's own objects. */
function cloneInto(window, value, seen) {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'function' || typeof value === 'symbol') throw new window.DOMException(`${String(value)} could not be cloned.`, 'DataCloneError');
        return value;
    }
    if (seen.has(value)) return seen.get(value);
    // Blobs and Files cannot change, so the copy can be the same one, as far as anything can tell.
    if (value instanceof window.Blob) return value;
    if (value instanceof window.Node || value instanceof window.Event) throw new window.DOMException('A DOM object could not be cloned.', 'DataCloneError');
    const tag = Object.prototype.toString.call(value);
    let copy;
    switch (tag) {
        case '[object Date]': copy = new window.Date(value.getTime()); break;
        case '[object RegExp]': copy = new window.RegExp(value.source, value.flags); break;
        case '[object Boolean]': case '[object Number]': case '[object String]': copy = new window.Object(value.valueOf()); break;
        case '[object ArrayBuffer]': copy = value.slice(0); break;
        case '[object Map]':
            copy = new window.Map();
            seen.set(value, copy);
            for (const [key, item] of value) copy.set(cloneInto(window, key, seen), cloneInto(window, item, seen));
            return copy;
        case '[object Set]':
            copy = new window.Set();
            seen.set(value, copy);
            for (const item of value) copy.add(cloneInto(window, item, seen));
            return copy;
        case '[object Array]':
            copy = new window.Array(value.length);
            seen.set(value, copy);
            value.forEach((item, index) => { copy[index] = cloneInto(window, item, seen); });
            return copy;
        case '[object Error]':
            copy = new window.Error(value.message);
            copy.name = value.name;
            break;
        default:
            if (ArrayBuffer.isView(value)) { copy = value.slice(0); break; }
            copy = new window.Object();
            seen.set(value, copy);
            for (const key of Object.keys(value)) copy[key] = cloneInto(window, value[key], seen);
            return copy;
    }
    seen.set(value, copy);
    return copy;
}
