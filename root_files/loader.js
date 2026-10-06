/*!
 * Web UI Loader - https://webui.stoicdreams.com
 * This script is used to dynamically load Web UI web components (webui-*) from cdn.myfi.ws and app components (app-*) from the local /wc (webui.appSrc) folder as they are encountered in the dom.
 * Authored by Erik Gassler - Stoic Dreams
 * Copyright © 2024-2025 Stoic Dreams - https://www.stoicdreams.com
 * Licensed under the MIT license - https://github.com/StoicDreams/MyFiCDN/blob/main/LICENSE
 */
"use strict";
const webui = (() => {
    {
        const markdownSrc =
            location.port === "3180"
                ? "/js/mdparse.min.js"
                : "https://cdn.myfi.ws/js/mdparse.min.js";
        import(markdownSrc).then((module) => {
            webui.markdown = new module.MarkdownParser();
            webui.loaded = true;
        });
    }
    const domain = location.hostname;
    const AsyncFunction = (async () => {}).constructor;
    window.AsyncFunction = AsyncFunction;
    const map = {
        subs: {},
        triggers: {},
        hides: new Set(),
    };
    // TODO: Temp debug
    window.subs = map.subs;
    const resizeSubscribers = {};
    const roles = {};
    function updatePageTitle() {
        let pt = [];
        pt.push(webui.getData("page-title"));
        pt.push(webui.getData("page-subtitle"));
        pt.push(location.hash);
        pt = pt.filter((a) => !!a);
        let title = pt.join(": ") || webui.getData("app-company-singular");
        if (!title) return;
        document.title = webui.replaceAppData(title);
    }
    let lastActive = Date.now();
    {
        const minTimeout = 1000 * 60 * 5;
        function checkForRoleRefresh() {
            if (webui.userRoles !== 0) {
                let autoSignout =
                    (webui.getData("session-autosignout") || 30) * 60 * 1000;
                if (autoSignout < minTimeout) {
                    autoSignout = minTimeout;
                }
                let expiresAt = lastActive + autoSignout;
                if (Date.now() < expiresAt) {
                    setTimeout(() => checkForRoleRefresh(), autoSignout);
                    webui.loadRoles();
                } else {
                    setTimeout(() => checkForRoleRefresh(), minTimeout);
                }
            } else {
                setTimeout(() => checkForRoleRefresh(), minTimeout);
            }
        }
        setTimeout(() => checkForRoleRefresh(), minTimeout);
    }
    const appDataOnce = [];
    const appDataLimit = [
        "app-name",
        "app-company-singular",
        "app-company-possessive",
        "app-domain",
        "app-api",
        "app-not-found-html",
        "app-data-endpoint",
        "app-content-endpoint",
    ];
    const notifyForAppDataChanges = [];
    const notifyForSessionDataChanges = [];
    function notifyAppDataChanged(changeDetails) {
        notifyForAppDataChanges.forEach((handler) => {
            if (!handler) return;
            handler(changeDetails, watchedAppData);
        });
    }
    function notifySessionDataChanged(changeDetails) {
        notifyForSessionDataChanges.forEach((handler) => {
            if (!handler) return;
            handler(changeDetails, watchedSessionData);
        });
        storage.setItem("session-data", JSON.stringify(watchedSessionData));
    }
    function getHandler(notifyHandler) {
        const handler = {
            set(target, property, value, receiver) {
                const oldValue = target[property];
                const changeType = property in target ? "update" : "add";
                const success = Reflect.set(target, property, value, receiver);
                if (success && oldValue !== value) {
                    notifyHandler({
                        type: changeType,
                        property: property,
                        oldValue: oldValue,
                        newValue: value,
                        timestamp: new Date(),
                    });
                }
                return success;
            },
            deleteProperty(target, property) {
                if (property in target) {
                    const oldValue = target[property];
                    const success = Reflect.deleteProperty(target, property);
                    if (success) {
                        notifyHandler({
                            type: "delete",
                            property: property,
                            oldValue: oldValue,
                            timestamp: new Date(),
                        });
                    }
                    return success;
                }
                return true;
            },
        };
        return handler;
    }
    const watchedAppData = (() => {
        const appData = {
            "app-name": "App",
            "app-company-singular": "Company",
            "app-company-possessive": `Company's`,
            "app-content-endpoint": "/d",
            "app-domain": domain.toLowerCase(),
            "page-title": "",
            "page-subtitle": "",
            "page-path": location.pathname,
        };
        return new Proxy(appData, getHandler(notifyAppDataChanged));
    })();
    // TODO: debug
    window.appData = watchedAppData;
    let isProcessing = false;
    const watchedSessionData = (() => {
        let sessionData = {
            "session-user-role": 0,
            "session-username": "Guest",
            "session-full-name": "Guest",
            "session-first-name": "Guest",
            "session-last-name": "",
            "session-autosignout": 30,
        };
        return new Proxy(sessionData, getHandler(notifySessionDataChanged));
    })();
    // TODO: debug
    window.sessionData = watchedSessionData;
    const appSettings = {
        appType: "website",
        isDesktopApp: false,
        rootPage: "root",
        contentExtension: ".md",
        pageContentEndpoint: "/d",
        encryptPageContent: false,
        encryptPageData: "base64",
    };
    let debug = false;
    const memStorageCache = {};
    const STORAGE_ACCEPTED_KEY = "storage_accepted";
    const ACCEPT_SESSION_STORAGE = "1";
    const ACCEPT_LOCAL_STORAGE = "2";
    const cachedFetches = {};
    let acceptedStorage = ACCEPT_SESSION_STORAGE;
    if (
        localStorage.key(STORAGE_ACCEPTED_KEY) &&
        localStorage.getItem(STORAGE_ACCEPTED_KEY) === ACCEPT_LOCAL_STORAGE
    ) {
        acceptedStorage = ACCEPT_LOCAL_STORAGE;
        Object.keys(localStorage).forEach((key) => {
            memStorageCache[key] = localStorage.getItem(key);
        });
        sessionStorage.clear();
    } else {
        acceptedStorage = ACCEPT_SESSION_STORAGE;
        Object.keys(sessionStorage).forEach((key) => {
            memStorageCache[key] = sessionStorage.getItem(key);
        });
        localStorage.clear();
    }
    function getCache() {
        return new Promise((resolve, reject) => {
            if (localStorage.getItem(STORAGE_ACCEPTED_KEY)) {
                resolve(localStorage);
            } else {
                resolve(sessionStorage);
            }
        });
    }
    class MemStorage {
        STORAGE_ACCEPTED_KEY = STORAGE_ACCEPTED_KEY;
        ACCEPT_SESSION_STORAGE = ACCEPT_SESSION_STORAGE;
        ACCEPT_LOCAL_STORAGE = ACCEPT_LOCAL_STORAGE;
        key(key) {
            return Object.keys(memStorageCache).filter((m) => m == key).length >
                0
                ? key
                : null;
        }
        clear() {
            Object.keys(memStorageCache).forEach((key) => {
                this.removeItem(key);
            });
            getCache().then((cache) => {
                cache.clear();
            });
        }
        removeItem(key) {
            delete memStorageCache[key];
            getCache()
                .then((cache) => {
                    cache.removeItem(key);
                })
                .catch((_) => {});
        }
        setItem(key, value) {
            memStorageCache[key] = value;
            getCache()
                .then((cache) => {
                    cache.setItem(key, value);
                })
                .catch((_) => {
                    // Caching not accepted
                });
        }
        getItem(key) {
            return memStorageCache[key] ?? "";
        }
        acceptLocalStorage() {
            acceptedStorage = ACCEPT_LOCAL_STORAGE;
            this.setItem(STORAGE_ACCEPTED_KEY, acceptedStorage);
            sessionStorage.clear();
            Object.keys(memStorageCache).forEach((key) => {
                localStorage.setItem(key, memStorageCache[key]);
            });
        }
        acceptSessionStorage() {
            acceptedStorage = ACCEPT_SESSION_STORAGE;
            this.setItem(STORAGE_ACCEPTED_KEY, acceptedStorage);
            localStorage.clear();
            Object.keys(memStorageCache).forEach((key) => {
                sessionStorage.setItem(key, memStorageCache[key]);
            });
        }
    }
    const storage = new MemStorage();
    class WebUI {
        /**
         * Relative path to custom web components.
         * Change this only if you use a different subfolder to hold your custom components.
         *
         * @returns {string} '.min'
         * @example
         * webui.appSrc = '/custom-components';
         */
        appSrc = "/wc";
        /**
         * Postfix for web components.
         * Set this to '' if you want non-minified versions of web components.
         *
         * @returns {string} '.min' | ''
         * @example
         * webui.appMin = '';
         */
        appMin = ".min";
        /**
         * App configuration data.
         * Typically this should only be updated by webui-app-config.
         *
         * @returns {object}
         * @example html
         * <webui-app-config example="one"></webui-app-config>
         */
        appConfig = {};
        /**
         * Instance of class MarkdownParser - a Web UI specific Markdown parser.
         *
         * This is a custom markdown parser developed specifically for Web UI flavored markdown which prioritizes HTML support within markdown and using Web UI components to handle specific conversion to HTML.
         *
         * Standard markdown is generally supported, but can include extra syntax support for Web UI specific options.
         *
         * One noteable deviation from standard markdown is sequential paragraph lines are not merged into a single paragraph, but instead are treated as separate paragraphs.
         *
         * @returns {MarkdownParser}
         * @example
         * let markdown = '# Title';
         * let result = webui.markdown.parse(markdown);
         */
        markdown = {
            parse(...args) {
                console.error("Unhandled webui.markdown parse", args);
                return "";
            },
        };
        constructor() {
            this._appSettings = appSettings;
            this.storage = storage;
            let cachedSessionData = this.storage.getItem("session-data") || {};
            if (typeof cachedSessionData === "string") {
                cachedSessionData = JSON.parse(cachedSessionData);
            }
            Object.keys(cachedSessionData).forEach((key) => {
                watchedSessionData[key] = cachedSessionData[key];
            });
        }
        /**
         * Alert system for displaying alerts to user
         *
         * To fully enable this process, include <webui-alerts> component in your index.html.
         *
         * @param {string} message - Message to display to user
         * @param {string} variant - danger|success|warning|info
         * @returns {undefined}
         * @example
         * webui.alert('Hello World');
         * webui.alert('Hello World', 'danger');
         * webui.alert('Hello World', 'warning');
         * webui.alert('Hello World', 'success');
         */
        alert(message, variant) {
            webui.log.warn(
                "Alerts are not setup for this website",
                message,
                variant,
            );
        }
        /**
         * Apply data to markdown and convert to HTML
         *
         * @param {string} content - Markdown to apply data to and convert to HTML.
         * @param {boolean} preTrim - Pretrim leading spaces in lines prior to conversion.
         * @param {boolean} noParagraph - Exclude wrapping single lined content with a paragraph element.
         * @returns {string} Converted HTML.
         * @example
         * '<p>Hello World</p>\n' == webui.applyAppDataToContent('Hello World');
         */
        applyAppDataToContent(content, preTrim, noParagraph) {
            let data =
                typeof preTrim !== undefined && typeof preTrim !== "boolean"
                    ? preTrim
                    : undefined;
            let pt = typeof preTrim == "boolean" ? preTrim : undefined;
            return this.parseWebuiMarkdown(
                this.replaceAppData(content, data),
                pt,
                noParagraph,
            );
        }
        /**
         * Placeholder for method to call when applying dynamic styles.
         *
         * This method is intended to be overwritten by the app.js component.
         *
         * This should generally only be used internally by Web UI.
         *
         * @returns {undefined}
         * @example
         * // within an app.js component constructor
         * webui.applyDynamicStyles = () => { t.applyDynamicStyles(); };
         */
        applyDynamicStyles() {}
        /**
         * Safely deep clone an object.
         *
         * @param {any} data - Any data
         * @returns {any}
         * @example
         * let original = {one:[1,2,3]};
         * let cloned = webui.clone(original);
         * original.one.shift();
         * console.log(original, cloned); // {one:[2,3]}, {one:[1,2,3]}
         */
        clone(data) {
            if (data === undefined || data === null) return data;
            if (typeof data !== "object") return data;
            try {
                return structuredClone(data);
            } catch {
                data = { ...data };
                return structuredClone(data);
            }
        }
        /**
         * Escape special characters from text meant to include in code snippet.
         *
         * Escapes &, <, and >.
         *
         * @param {string} text - Text to apply translations to.
         * @returns {string}
         * @example
         * let original = {one:[1,2,3]};
         * let cloned = webui.clone(original);
         * original.one.shift();
         * console.log(original, cloned); // {one:[2,3]}, {one:[1,2,3]}
         */
        escapeCode(text) {
            return text
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");
        }
        /**
         * Escape double quotes.
         *
         * @param {string} text
         * @returns {string}
         */
        escapeQuote(text) {
            return text.replace(/"/g, "&quot;");
        }
        /**
         * Escape special characters for HTML.
         *
         * replaces " with &amp;quot;
         *
         * replaces ' with &amp;#039;
         *
         * replaces & with &amp;amp;
         *
         * replaces < with &amp;lt;
         *
         * replaces > with &amp;gt;
         *
         * @param {string} text
         * @returns {string}
         */
        escapeHtml(text) {
            return text
                .replace(/&/g, "&amp;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");
        }
        /**
         * Create an element.
         *
         * @param {string} name
         * @param {object} attr
         * @returns {Node}
         */
        create(name, attr) {
            let el = document.createElement(name);
            return this.attachAttributes(el, attr);
        }
        /**
         * Convert html representing a single element into a Node.
         *
         * @param {string} html
         * @param {object} attr
         * @returns {Node}
         */
        createFromHTML(html, attr) {
            let container = this.create("div");
            container.innerHTML = html;
            let el = container.childNodes[0];
            if (!el) return el;
            return this.attachAttributes(el, attr);
        }
        /**
         * Attach attributes to an element.
         *
         * @param {Node} el - The element to attach attributes to.
         * @param {object} attr - The attributes to attach.
         * @returns {Node}
         */
        attachAttributes(el, attr) {
            if (attr) {
                Object.keys(attr).forEach((key) => {
                    switch (key) {
                        case "innerHTML":
                        case "html":
                            el.innerHTML = attr[key];
                            break;
                        case "innerText":
                        case "text":
                            el.innerText = attr[key];
                            break;
                        default:
                            if (typeof attr[key] === "function") {
                                el.addEventListener(key, attr[key]);
                            } else {
                                el.setAttribute(key, attr[key]);
                            }
                            break;
                    }
                });
            }
            return el;
        }
        /**
         * Find the closest ancestor element that matches the selector.
         *
         * @param {Node} target
         * @param {string} selector
         * @returns {Node}
         */
        closest(target, selector) {
            if (!target) return null;
            if (target.composedPath instanceof Function) {
                const path = target.composedPath();
                for (const el of path) {
                    if (el instanceof Element && el.matches(selector))
                        return el;
                }
            } else {
                let el = target;
                while (el) {
                    if (el.matches instanceof Function && el.matches(selector))
                        return el;
                    el = el.parentNode || el.host;
                }
            }
            return null;
        }
        /**
         * Copy a string to the clipboard.
         *
         * @param {string} value
         * @returns {undefined}
         */
        async copyToClipboard(value) {
            await navigator.clipboard.writeText(value);
            webui.alert("Copied code to clipboard", "success");
        }
        /**
         * Defines a custom web component.
         *
         * This is the base for how all Web UI components are created.
         *
         * @param {string} name
         * @param {object} options
         * @returns {Node}
         */
        define(name, options) {
            if (typeof name !== "string") {
                console.error("name in webui.define(name) must be a string");
                return;
            }
            if (
                name.substring(0, 6) !== "webui-" &&
                name.substring(0, 4) !== "app-"
            ) {
                console.error(
                    "name in webui.define(name) must start with the prefix `app-`.",
                );
                return;
            }
            options = options || {};
            options.attr = options.attr || [];
            if (typeof options.attr === "string") {
                options.attr = options.attr.split(/[, ]+/);
            }
            options.flags = options.flags || [];
            if (typeof options.flags === "string") {
                options.flags = options.flags.split(/[, ]+/);
            }
            ["class"].forEach((attr) => {
                if (options.attr.indexOf(attr) === -1) {
                    options.attr.push(attr);
                }
            });
            let defineOptions = {};
            let shadowTemplate = 0;
            if (options.shadowTemplate) {
                shadowTemplate = webui.create("template");
                shadowTemplate.setAttribute("shadowrootmode", true);
                if (options.linkCss) {
                    shadowTemplate.innerHTML = `<link rel="stylesheet" href="https://cdn.myfi.ws/css/webui.min.css">${options.shadowTemplate}`;
                } else {
                    shadowTemplate.innerHTML = options.shadowTemplate;
                }
                delete options.shadowTemplate;
            }
            if (
                options.watchVisibility &&
                options.attr.indexOf("visible") === -1
            ) {
                options.attr.push("visible");
            }
            let isInput = options.isInput || name.indexOf("input") !== -1;
            class CustomElement extends HTMLElement {
                static formAssociated = isInput;
                disconnectHandlers = [];
                constructor() {
                    super();
                    const t = this;
                    if (isInput) {
                        t.internals_ = t.attachInternals();
                        t.addEventListener("keyup", (ev) => {
                            if (ev.key === "Enter" && ev.ctrlKey) {
                                let form = t.internals_.form;
                                ev.preventDefault();
                                ev.stopPropagation();
                                form?.requestSubmit();
                            }
                        });
                    }
                    if (options.props) {
                        Object.keys(options.props).forEach((key) => {
                            Object.defineProperty(t, key, options.props[key]);
                        });
                    }
                    if (isInput) {
                        Object.defineProperty(t, "name", {
                            get() {
                                return t.getAttribute("name");
                            },
                            set(v) {
                                t.setAttribute("name", v);
                            },
                        });
                        if (!t.formResetCallback) {
                            t.formResetCallback = () => {
                                t.value = "";
                            };
                        }
                        if (!t.formStateRestoreCallback) {
                            t.formStateRestoreCallback = (state) => {
                                t.value = state;
                            };
                        }
                        t.addEventListener("input", (_) => {
                            t.internals_.setFormValue(t.value);
                        });
                        t.addEventListener("change", (_) => {
                            t.internals_.setFormValue(t.value);
                        });
                    }
                    t._id = `d${webui.uuid()}`
                        .split("-")
                        .join("")
                        .toLowerCase();
                    t.options = options;
                    if (shadowTemplate) {
                        t.template = shadowTemplate.content.cloneNode(true);
                    }
                    Object.keys(options).forEach((key) => {
                        if (key === "constructor") {
                            t._constructor = options[key].bind(t);
                        } else if (typeof options[key] === "function") {
                            t[key] = options[key].bind(t);
                        } else {
                            t[key] = options[key];
                        }
                    });
                    if (t._constructor) {
                        t._constructor();
                    }
                    if (options.watchVisibility) {
                        let observer = new IntersectionObserver(
                            onIntersection,
                            {
                                root: null,
                                scrollMargin: "0px",
                                threshold: 0,
                                delay: 100,
                            },
                        );
                        function onIntersection(entries, _opts) {
                            entries.forEach((entry) => {
                                if (entry.isIntersecting) {
                                    entry.target.setAttribute("visible", 1);
                                } else {
                                    entry.target.removeAttribute("visible");
                                }
                            });
                        }
                        observer.observe(t);
                        this.disconnectHandlers.push(() => {
                            observer.unobserve(t);
                        });
                    }
                    if (shadowTemplate) {
                        const shadow = t.attachShadow({ mode: "open" });
                        // Something is copying attributes from the parent webui-dropdown to the input/select elements on the first click in Edge browser.
                        function removeBugAttributes(el) {
                            [
                                "value",
                                "preload",
                                "data-options",
                                "data-trigger",
                                "data-subscribe",
                            ].forEach((key) => {
                                el.removeAttribute(key);
                            });
                        }
                        ["input", "select"].forEach((selector) => {
                            webui
                                .querySelectorAll(selector, t.template)
                                .forEach((el) => {
                                    ["event", "click", "blur"].forEach(
                                        (evname) => {
                                            el.addEventListener(
                                                evname,
                                                (ev) => {
                                                    setTimeout(() => {
                                                        removeBugAttributes(el);
                                                    }, 0);
                                                },
                                            );
                                        },
                                    );
                                    ["input", "change"].forEach((evname) => {
                                        el.addEventListener(evname, (ev) => {
                                            t.dispatchEvent(
                                                new Event(evname, {
                                                    bubbles: true,
                                                    composed: true,
                                                }),
                                            );
                                        });
                                    });
                                });
                        });
                        shadow.appendChild(t.template);
                    }
                    t._isConstructed = true;
                }
                static get observedAttributes() {
                    return options.attr.concat(options.flags);
                }
                addDataset(key, value) {
                    const t = this;
                    if (t.hasDataset(key, value)) {
                        webui.log.info(
                            "Dataset already has that value",
                            key,
                            value,
                        );
                        return;
                    }
                    let ds = t.getAttribute(`data-${key}`);
                    ds = ds ? ds.split("|") : [];
                    ds.push(value);
                    t.setAttribute(`data-${key}`, ds.join("|"));
                }
                hasDataset(key, value) {
                    const t = this;
                    let ds = t.getAttribute(`data-${key}`);
                    ds = ds ? ds.split("|") : [];
                    if (value === undefined) {
                        return ds.length !== 0;
                    }
                    let found = false;
                    ds.forEach((item) => {
                        let k = item.split(":")[0];
                        if (k === key) {
                            found = true;
                        }
                    });
                    return found;
                }
                attributeChangedCallback(property, oldValue, newValue) {
                    const t = this;
                    if (oldValue === newValue) return;
                    let propDefined = property;
                    property = webui.toCamel(property);
                    if (["class"].indexOf(property) !== -1) {
                        property = `_${property}`;
                    }
                    if (
                        property === "_class" &&
                        t.shadowRoot &&
                        t.shadowRoot.childNodes
                    ) {
                        t.shadowRoot.childNodes.forEach((node) => {
                            if (node.nodeName === "SLOT") {
                                node.className = newValue;
                            }
                        });
                    }
                    if (
                        options.flags.indexOf(propDefined) !== -1 ||
                        options.flags.indexOf(property) !== -1
                    ) {
                        newValue = webui.setFlag(this, property, newValue);
                    } else {
                        webui.setProperty(this, property, newValue);
                    }
                    if (t.attrChanged) {
                        t.attrChanged(property, newValue);
                    }
                }
                async connectedCallback() {
                    const t = this;
                    if (typeof options.onResize === "function") {
                        resizeSubscribers[t._id] = options.onResize.bind(t);
                    }
                    if (options.content) {
                        t.classList.add("content");
                    }
                    if (t._connectedInit) {
                        if (typeof t.reconnected === "function") {
                            setTimeout(() => {
                                t.reconnected();
                            }, 1);
                        }
                        return;
                    }
                    t._connectedInit = true;
                    t._isConnected = true;
                    checkAddedNode(t);
                    if (t.preload) {
                        await preloadComponents(t.preload);
                    }
                    if (typeof t.connected === "function") {
                        setTimeout(() => {
                            t.connected();
                        }, 1);
                    }
                    if (
                        t.shadowRoot &&
                        t.shadowRoot &&
                        t.shadowRoot.childNodes
                    ) {
                        t.setAttribute("has-shadow", true);
                        t.shadowRoot.childNodes.forEach((node) => {
                            if (node.nodeName === "SLOT") {
                                node.classList = t.classList;
                            }
                        });
                    }
                    if (isInput) {
                        t.internals_.setFormValue(t.value);
                    }
                }
                disconnectedCallback() {
                    const t = this;
                    t._isConnected = false;
                    if (resizeSubscribers[t._id]) {
                        delete resizeSubscribers[t._id];
                    }
                    if (typeof t.disconnected === "function") {
                        t.disconnected();
                    }
                    t.disconnectHandlers.forEach((h) => {
                        h();
                    });
                }
                getSlot(name) {
                    let node = null;
                    this.childNodes.forEach((n) => {
                        if (n.slot === name) {
                            node = n;
                        }
                    });
                    return node;
                }
                isFlagged(name) {
                    return this[name] !== undefined && this[name] !== false;
                }
                setTheme(value) {
                    this.style.setProperty(
                        "--theme-color",
                        `var(--color-${value})`,
                    );
                    this.style.setProperty(
                        "--theme-color-offset",
                        `var(--color-${value}-offset)`,
                    );
                }
                setHeight(value) {
                    let num = webui.pxIfNumber(value);
                    this.style.height = num;
                    this.style.minHeight = num;
                }
                snapshot() {
                    const t = this;
                    let snapshot = {};
                    if (t.options?.attr?.length) {
                        t.options.attr.forEach((attr) => {
                            let key = webui.toCamel(attr);
                            snapshot[key] = t[key];
                        });
                    }
                    if (t.props) {
                        Object.keys(t.props).forEach((key) => {
                            snapshot[key] = t[key];
                        });
                    }
                    if (typeof t.value !== "undefined") {
                        snapshot.value = t.value;
                    }
                    snapshot.classList = Array.from(t.classList).sort();
                    t._snapshot = JSON.stringify(snapshot);
                    return t._snapshot;
                }
                get hasChanges() {
                    let a = this._snapshot;
                    let b = this.snapshot();
                    if (a === undefined) {
                        return true;
                    }
                    return a !== b;
                }
            }
            customElements.define(name, CustomElement, defineOptions);
        }
        /**
         * Display a duration of seconds in a human readable format.
         *
         * @param {number} value
         * @param {string} onZero
         * @returns {string}
         */
        displaySeconds(value, onZero = "0 seconds") {
            let seconds = parseFloat(value) || 0;
            if (seconds === 0) return onZero;
            if (seconds < 60) return `${value} seconds`;
            let min = Math.floor(seconds / 60);
            seconds = seconds % 60;
            if (min < 60) return `${min} min, ${seconds} sec`;
            let hr = Math.floor(min / 60);
            min = min % 60;
            if (hr < 24)
                return `${hr} hr${hr > 1 ? "s" : ""}, ${min} min, ${seconds} sec`;
            let days = Math.floor(hr / 24);
            hr = hr % 24;
            let result = [];
            result.push(`${days} day${days > 1 ? "s" : ""}`);
            min = min + hr * 60;
            seconds = seconds + min * 60;
            if (seconds > 0) {
                result.push(webui.displaySeconds(seconds));
            }
            return result.join(" ");
        }
        /**
         * Display a duration of minutes in a human readable format.
         *
         * @param {number} value
         * @param {string} onZero
         * @returns {string}
         */
        displayMinutes(value, onZero = "0 minutes") {
            let min = parseFloat(value) || 0;
            if (min === 0) return onZero;
            if (min < 60) return `${min} minutes`;
            let hr = Math.floor(min / 60);
            min = min % 60;
            if (hr < 24) return `${hr} hr${hr > 1 ? "s" : ""}, ${min} min`;
            let days = Math.floor(hr / 24);
            hr = hr % 24;
            let result = [];
            result.push(`${days} day${days > 1 ? "s" : ""}`);
            min = min + hr * 60;
            if (min > 0) {
                result.push(webui.displayMinutes(min));
            }
            return result.join(" ");
        }
        /**
         * Display a number with leading zeros.
         *
         * @param {number} number - The number to format.
         * @param {number} count - The total length of the output string.
         * @returns {string}
         */
        displayLeadingZero(number, count = 1) {
            let pad = 1 + count - `${number}`.length;
            if (pad <= 0) return `${number}`;
            return `${"0".repeat(pad)}${number}`;
        }
        /**
         * Escape text for display in HTML.
         *
         * replaces & with &amp;amp;
         *
         * replaces < with &amp;lt;
         *
         * replaces > with &amp;gt;
         *
         * replaces " with &amp;quot;
         *
         * replaces ' with &amp;#39;
         *
         * replaces / with &amp;#x2F;
         *
         * replaces ` with &amp;#96;
         *
         * @param {string} text
         * @returns {string}
         */
        escapeForHTML(text) {
            return text
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#39;")
                .replace(/\//g, "&#x2F;")
                .replace(/`/g, "&#96;");
        }
        /**
         * Fetch from API using root endpoint as defined in App config.
         *
         * @param {string} url
         * @param {object} data
         * @param {string} method (POST|GET|DELETE|PATCH)
         * @returns {string}
         */
        async fetchApi(url, data, method = "POST") {
            const t = this;
            if (!url.startsWith("http")) {
                let limit = 0;
                while (!t.appConfig.appApi && limit++ < 100) {
                    await t.wait(100);
                }
                const api = t.appConfig.appApi || "";
                url = url[0] === "/" ? `${api}${url}` : `${api}/${url}`;
            }
            let headers = {};
            if (data && data.headers) {
                headers = data.headers;
                delete data.headers;
            }
            let body = data;
            headers["Content-Type"] = "text/plain";
            if (!headers["x-cookie-age"]) {
                headers["x-cookie-age"] =
                    webui.getData("session-autosignout") || 30;
            }
            if (["get"].indexOf(method.toLowerCase()) !== -1) {
                body = undefined;
            } else if (data instanceof FormData) {
                headers["Content-Type"] = "multipart/form-data";
            } else if (typeof data !== "string") {
                headers["Content-Type"] = "application/json";
                body = JSON.stringify(data);
            }
            return await fetch(url, {
                method: method.toUpperCase(),
                credentials: "include",
                mode: "cors",
                cache: "no-cache",
                body: body,
                headers: headers,
            });
        }
        /**
         * Fetch from url using a get request, caching response. Subsequent requests to the same url will skip fetch and just returned cached data.
         *
         * Endpoint is expected to not change for lifetime of user session.
         *
         * @param {string} url
         * @param {boolean} isJson Set true to apply JSON parsing on response body, false to return body untouched.
         * @returns {string|any}
         */
        fetchWithCache(url, isJson) {
            return new Promise((resolve, reject) => {
                if (cachedFetches[url]) {
                    resolve(cachedFetches[url]);
                } else {
                    fetch(url)
                        .then(async (res) => {
                            if (isJson) {
                                await res.json().then((json) => {
                                    cachedFetches[url] = json;
                                    resolve(json);
                                });
                            } else {
                                await res.text().then((text) => {
                                    cachedFetches[url] = text;
                                    resolve(text);
                                });
                            }
                        })
                        .catch((ex) => {
                            reject(ex);
                        });
                }
            });
        }
        /**
         * Decode base64 string to decoded value.
         *
         * @param {string} encoded
         * @returns {string}
         */
        fromBase64(encoded) {
            encoded = encoded.replace(/-/g, "+").replace(/_/g, "/");
            while (encoded.length % 4 !== 0) {
                encoded = `${encoded}=`;
            }
            return atob(encoded);
        }
        /**
         * Helper to format bytes into KB/MB.
         *
         * @param {string} bytes - bytes
         * @param {string} decimals - default 2
         * @returns {undefined}
         * @example
         * webui.formatBytes(webui.getBase64Size(btoa('Hello World')));
         */
        formatBytes(bytes, decimals = 2) {
            if (!+bytes) return "0 Bytes";
            const k = 1024;
            const dm = decimals < 0 ? 0 : decimals;
            const sizes = ["Bytes", "KB", "MB", "GB"];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
        }
        /**
         * Helper to calculate exact bytes from Base64 string.
         *
         * @param {string} base64String - base64 string to calculate size from
         * @returns {undefined}
         * @example
         * webui.getBase64Size(btoa('Hello World'));
         * webui.formatBytes(webui.getBase64Size(btoa('Hello World')));
         */
        getBase64Size(base64String) {
            if (!base64String) return 0;
            let clean = base64String.includes(",")
                ? base64String.split(",")[1]
                : base64String;
            let padding = (clean.match(/=*$/) || [""])[0].length;
            return clean.length * 0.75 - padding;
        }
        /**
         * Get data from key, or pass multiple keys to return array of results.
         *
         * @param {string} args
         * @returns {any}
         */
        getData(...args) {
            if (args.length === 0) return undefined;
            if (args.length > 1) {
                let result = [];
                args.forEach((key) => {
                    result.push(webui.getData(key));
                });
                return result;
            }
            if (typeof args[0] !== "string") {
                console.error("Invalid key for webui.getData", args[0], args);
                return;
            }
            let key = args[0].split(":")[0];
            let dataContainer = webui.toSnake(key, "-").startsWith("session-")
                ? watchedSessionData
                : watchedAppData;
            let data = webui.getNestedData(key, dataContainer);
            if (data === undefined) {
                data = webui.getNestedData(
                    `session-${key}`,
                    watchedSessionData,
                );
                if (data !== undefined) return webui.clone(data);
                data = webui.getNestedData(`app-${key}`, watchedAppData);
                if (data !== undefined) return webui.clone(data);
                return undefined;
            }
            if (typeof data !== "object") return data;
            return webui.clone(data);
        }
        /**
         * Get nested data from an object using a dot notation key.
         *
         * @param {string} key - The dot notation key to search for.
         * @param {object} data - The object to search within.
         * @returns {any}
         */
        getNestedData(key, data) {
            let segments = key.split(".");
            if (!data) return undefined;
            if (segments.length === 1) {
                let skey = webui.toSnake(key, "-");
                return webui.getDefined(data[skey], data[key], undefined);
            }
            key = segments.shift();
            let skey = webui.toSnake(key, "-");
            data = webui.getDefined(data[skey], data[key], undefined);
            while (segments.length > 0) {
                if (!data) return undefined;
                key = segments.shift();
                skey = webui.toSnake(key, "-");
                data = webui.getDefined(data[skey], data[key], undefined);
            }
            return data;
        }
        /**
         * Return first argument that is not null or undefined.
         *
         * @param {any} args - The arguments to check.
         * @returns {any}
         */
        getDefined(...args) {
            for (let index = 0; index < args.length; ++index) {
                if (args[index] !== undefined && args[index] !== null) {
                    return args[index];
                }
            }
            return undefined;
        }
        /**
         * Transform a markdown template to HTML.
         *
         * Optionally apply data to the template.
         *
         * @param {string} template - The markdown to use.
         * @param {object} data - The data to apply to the template.
         * @returns {string}
         */
        getHtmlFromTemplate(template, data) {
            if (!template || typeof template.assignedElements !== "function")
                return "";
            let html = [];
            template.assignedElements().forEach((t) => {
                let v = t.innerHTML;
                if (v) {
                    html.push(v);
                }
            });
            return this.applyAppDataToContent(html.join("\n"), data);
        }
        /**
         * Get query data by key from the URL.
         *
         * @param {string} key - The key to search for in the query string.
         * @returns {string}
         */
        getQueryData(key) {
            let data = location.search;
            if (!data || data[0] !== "?") return null;
            let dict = {};
            data.substring(1)
                .split("&")
                .forEach((kv) => {
                    kv = kv.split("=");
                    dict[kv[0]] = kv[1];
                });
            if (!key) return dict;
            return dict[key];
        }
        /**
         * Get the value of a specific key from the response headers.
         *
         * @param {object} resp - The response object to search within.
         * @param {string} keys - The keys to search for in the response headers.
         * @returns {string}
         */
        getResponseHeader(resp, ...keys) {
            let message = undefined;
            keys.forEach((key) => {
                if (message) return;
                message = resp.headers.get(key);
            });
            return message;
        }
        /**
         * Get search data by key from the URL.
         *
         * @param {string} key - The key to search for in the query string.
         * @returns {object}
         */
        getSearchData(key) {
            return webui.getQueryData(key);
        }
        /**
         * Turn a string into a hashcode using a standard and repeatable algorithm.
         *
         * @param {string} text - The string to hash.
         * @returns {number}
         */
        hashCode(text) {
            if (typeof text === "undefined") return 0;
            if (typeof text !== "string") return -1;
            let hash = 0x811c9dc5;
            text = text || "";
            for (let i = 0; i < text.length; i++) {
                hash ^= text.charCodeAt(i);
                hash = (hash * 0x01000193) >>> 0;
            }
            return hash | 0;
        }
        /**
         * Turn a string into a SHA256 Hash.
         *
         * @param {string} text - The string to hash.
         * @returns {number}
         */
        async hashSHA256(text) {
            if (
                typeof window.crypto === "undefined" ||
                typeof window.crypto.subtle === "undefined"
            ) {
                throw new Error(
                    "Web Cryptography API is not available in this environment.",
                );
            }
            const encoder = new TextEncoder();
            const data = encoder.encode(text);
            const hashBuffer = await crypto.subtle.digest("SHA-256", data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");
            return hashHex;
        }
        /**
         * Check if an element has a specific setter field.
         *
         * @param {Node} el - The element to check.
         * @param {string} field - The name of the field to check for.
         * @returns {boolean}
         */
        hasSetter(el, field) {
            if (!el || typeof field !== "string") return false;
            let proto = el;
            while (proto) {
                const descriptor = Object.getOwnPropertyDescriptor(
                    proto,
                    field,
                );
                if (descriptor && typeof descriptor.set === "function") {
                    return true;
                }
                proto = Object.getPrototypeOf(proto);
            }
            return false;
        }
        /**
         * Check if two values are equal.
         *
         * @param {any} a - The first value to compare.
         * @param {any} b - The second value to compare.
         * @returns {boolean}
         */
        isEqual(a, b) {
            if (a === b) return true;
            if (typeof a !== typeof b) return false;
            if (a !== a && b !== b) return true;
            return JSON.stringify(a) === JSON.stringify(b);
        }
        /**
         * Check if the current domain is localhost.
         *
         * @returns {boolean}
         */
        get isLocalhost() {
            if (domain === "localhost") return true;
            if (parseInt(domain).toString() !== "NaN") return true;
            return false;
        }
        /**
         * Check if the text content of an element is overflowing its container.
         *
         * @param {Node} el - The element to check.
         * @returns {boolean}
         */
        isTextOverflowing(el) {
            return el.scrollWidth > el.clientWidth + 1;
        }
        /**
         * Is true if the user is signed in (i.e. role bit matches 1 signalling they are a user).
         *
         * @returns {boolean}
         */
        get isSignedIn() {
            const t = this;
            let role = t.getDefined(t.getData("session-user-role"), 0);
            return !!((role && 1) !== 0);
        }
        /**
         * Limit the number of characters in a string to the given limit.
         *
         * @param {string} text - The text to limit.
         * @param {number} limit - The maximum number of characters.
         * @returns {string}
         */
        limitChars(text, limit) {
            if (
                !text ||
                typeof limit !== "number" ||
                !text.length ||
                text.length <= limit ||
                !text.substring
            )
                return text;
            return text.substring(0, limit);
        }
        /**
         * Log messages to the console with various methods.
         *
         * @returns {object}
         */
        log = (() => {
            let log = (...args) => console.log(...args);
            log.assert = (...args) => console.assert(...args);
            log.info = (...args) => console.info(...args);
            log.dir = (...args) => console.dir(...args);
            log.trace = (...args) => console.trace(...args);
            log.error = (...args) => console.error(...args);
            log.warn = (...args) => console.warn(...args);
            log.time = (key) => console.time(key);
            log.timeEnd = (key) => console.timeEnd(key);
            return log;
        })();
        /**
         * Appends unit to input if input is just a number.
         *
         * This is used when applying styles from input that may inlude size postfix's such as %, em, etc.
         *
         * @param {string|number} input
         * @param {string} unit
         * @returns {string}
         */
        unitIfNumber(input, unit) {
            let num = parseFloat(input);
            if (num === input || `${num}` === input) {
                return `${num}${unit}`;
            }
            return input;
        }
        /**
         * Appends px to input if input is just a number.
         *
         * This is used when applying styles from input that may inlude size postfix's such as %, em, etc.
         *
         * @param {string|number} input
         * @returns {string}
         */
        pxIfNumber(input) {
            return this.unitIfNumber(input, "px");
        }
        /**
         * Appends ms to input if input is just a number.
         *
         * This is used when applying styles from input that may inlude size postfix's such as %, em, etc.
         *
         * @param {string|number} input
         * @returns {string}
         */
        msIfNumber(input) {
            return this.unitIfNumber(input, "ms");
        }
        /**
         * Navigate to the given relative url.
         *
         * @param {string} href
         * @returns {undefined}
         */
        navigateTo(href) {
            changePage(href);
        }
        /**
         * Update url hashcode with the given hash.
         *
         * @param {string} hash
         * @returns {undefined}
         */
        updateHash(hash) {
            hash = typeof hash !== "string" ? "" : hash;
            hash = hash.trim();
            if (hash !== "" && hash[0] !== "#") {
                hash = `#${hash}`;
            }
            changePage(`${location.pathname}${hash}${location.search}`);
            updatePageTitle();
        }
        /**
         * Remove wrapping <p> tags from HTML content.
         *
         * @param {string} html - The HTML content to modify.
         * @param {string} tagPattern - The pattern to match the tags.
         * @returns {string}
         */
        removeWrappingPTags(html, tagPattern) {
            while (html.match(`<p><(${tagPattern})[\> ]{1}`)) {
                let orig = html;
                html = html.replace(
                    new RegExp(
                        `\<p\>(\<(${tagPattern}).+\<\/\\2\>)\<\/p\>`,
                        "g",
                    ),
                    "$1",
                );
                if (html === orig) {
                    break;
                }
            }
            return html;
        }
        /**
         * Close the shared drawer.
         *
         * @returns {undefined}
         */
        async closeSharedDrawer() {
            let el = document.querySelector("webui-drawer.shared");
            if (!el) return;
            if (el.classList.contains("open")) {
                el.classList.remove("open");
                await webui.wait(400);
            }
        }
        /**
         * Open the shared drawer.
         *
         * @param {function|string} header
         * @param {function|string} content
         * @returns {Promise}
         */
        async openSharedDrawer(header, content) {
            if (content === undefined) {
                content = header;
                header = undefined;
            }
            if (typeof header === "function") {
                if (header.constructor == AsyncFunction) {
                    header = await header();
                } else {
                    header = header();
                }
            }
            if (typeof header === "string") {
                const container = webui.create("header");
                container.style.padding = "var(--padding)";
                container.setAttribute("slot", "header");
                container.innerHTML = header;
                header = container;
            } else {
                let hc = header;
                header = webui.create("header");
                header.style.padding = "var(--padding)";
                header.setAttribute("slot", "header");
                if (hc) {
                    header.appendChild(hc);
                }
            }
            if (typeof content === "function") {
                if (content.constructor == AsyncFunction) {
                    content = await content();
                } else {
                    content = content();
                }
            }
            if (typeof content === "string") {
                const container = webui.create("section");
                container.style.padding = "var(--padding)";
                container.style.display = "flex";
                container.style.flexDirection = "column";
                container.style.flexGrow = "1";
                container.style.overflow = "auto";
                container.style.gap = "var(--padding)";
                container.innerHTML = content;
                content = container;
            }
            let el = document.querySelector("webui-drawer.shared");
            if (!el) {
                webui.dialog({
                    title: header,
                    content: content,
                    confirm: "Close",
                });
                return;
            }
            if (el.classList.contains("open")) {
                el.classList.remove("open");
                await webui.wait(400);
            }
            el.innerHTML = "";
            el.appendChild(header);
            el.appendChild(content);
            await webui.wait(100);
            el.classList.add("open");
            return content;
        }
        /**
         * Parse Web UI specific markdown content.
         *
         * @param {string} md
         * @param {boolean} preTrim
         * @param {boolean} noParagraph
         * @returns {string}
         */
        parseWebuiMarkdown(md, preTrim, noParagraph) {
            return this.parseMarkdown(md, preTrim, noParagraph);
        }
        /**
         * Parse Web UI specific markdown content.
         *
         * @param {string} md
         * @param {boolean} preTrim
         * @param {boolean} noParagraph
         * @returns {string}
         */
        parseMarkdown(md, preTrim, noParagraph) {
            const t = this;
            if (typeof md !== "string") return md;
            if (preTrim) {
                md = t.trimLinePreWhitespce(md);
            }
            return t.markdown.parse(md, noParagraph) || "";
        }
        /**
         * Remove an elements parent if it is a <p> tag.
         *
         * @param {Node} el - The element to check for parent <p> tag.
         * @returns {Node}
         */
        removeFromParentPTag(el) {
            if (el.parentNode && el.parentNode.nodeName === "P") {
                let p = el.parentNode;
                if (p.parentNode) {
                    p.parentNode.insertBefore(el, p);
                    if (p.innerHTML.trim() === "") {
                        p.remove();
                    }
                }
            }
            return el;
        }
        /**
         * Remove all children from a node.
         *
         * @param {Node} el - The node to remove children from.
         * @param {function} condition - Optional condition to filter which children to remove.
         * @returns {array} removed children
         */
        removeChildren(el, condition) {
            let tr = [];
            el.childNodes.forEach((ch) => {
                if (typeof condition === "function") {
                    if (condition(ch)) {
                        tr.push(ch);
                    }
                } else {
                    tr.push(ch);
                }
            });
            tr.forEach((ch) => {
                ch.remove();
            });
            return tr;
        }
        /**
         * Remove all classes from an element that start with a specific prefix.
         *
         * @param {Node} el - The element to remove classes from.
         * @param {string} prefix - The class prefix to match for classes to remove.
         * @returns {undefined}
         */
        removeClass(el, prefix) {
            let r = [];
            el.classList.forEach((c) => {
                if (c.startsWith(prefix)) {
                    r.push(c);
                }
            });
            r.forEach((c) => el.classList.remove(c));
        }
        /**
         * Remove all children and nested children from a node that match the given selector.
         *
         * @param {string} parent - The parent element to remove children from.
         * @param {string} selector - The selector to match children elements.
         * @param {string} action - Optional action to perform on each matched element prior to removal.
         * @returns {undefined}
         */
        removeElements(parent, selector, action) {
            let tr = [];
            parent.querySelectorAll(selector).forEach((n) => {
                tr.push(n);
                if (typeof action === "function") {
                    action(n);
                }
            });
            tr.forEach((n) => {
                n.remove();
            });
        }
        /**
         * Repeat a string for a given length.
         *
         * @param {string} digit - The string to repeat.
         * @param {number} length - The number of times to repeat the string.
         * @returns {string}
         */
        repeat(digit, length) {
            if (!length) return "";
            let digits = [];
            let index = 0;
            while (index++ < length) {
                digits.push(digit);
            }
            return digits.join("");
        }
        /**
         * Replace app specific placeholders in a string with values from a data object.
         *
         * Placeholders are denoted by curly braces and keys in all-caps snake case, e.g. {APP_PLACEHOLDER}.
         *
         * @param {string} text - The string containing placeholders.
         * @param {object} data - The data object containing values to replace placeholders.
         * @returns {string}
         */
        replaceAppData(text, data) {
            if (typeof text !== "string") return text;
            if (data) {
                text = this.replaceData(text, data);
            }
            [watchedAppData, watchedSessionData].forEach((dataContainer) => {
                Object.keys(dataContainer).forEach((key) => {
                    let keys = [];
                    keys.push(`{${this.toSnake(key).toUpperCase()}}`);
                    if (key.startsWith("session-")) {
                        keys.push(
                            `{${this.toSnake(key.substring(8)).toUpperCase()}}`,
                        );
                    } else if (key.startsWith("app-")) {
                        keys.push(
                            `{${this.toSnake(key.substring(4)).toUpperCase()}}`,
                        );
                    }
                    let val = webui.getData(key);
                    if (val === undefined || val === null) {
                        val = "";
                    }
                    keys.forEach((rkey) => {
                        let limit = 0;
                        try {
                            while (text.indexOf(rkey) !== -1 && limit < 5) {
                                ++limit;
                                text = text.replaceAll(rkey, val);
                            }
                        } catch (ex) {
                            console.error("text", text, ex);
                        }
                    });
                });
            });
            return text;
        }
        /**
         * Replace template specific placeholders in a string with values from a data object.
         *
         * Placeholders are denoted by curly braces and keys in all-caps snake case, e.g. {TEMPLATE_KEY_NAME}.
         *
         * @param {string} text - The string containing placeholders.
         * @param {object} data - The data object containing values to replace placeholders.
         * @returns {string}
         */
        replaceData(text, data) {
            if (text.indexOf("{TEMPLATE_ROWDATA}") !== -1) {
                let rowData = webui.escapeForHTML(JSON.stringify(data));
                let limit = 0;
                while (
                    text.indexOf("{TEMPLATE_ROWDATA}") !== -1 &&
                    limit++ < 5
                ) {
                    text = text.replaceAll("{TEMPLATE_ROWDATA}", rowData);
                }
            }
            Object.keys(data).forEach((key) => {
                let keyName = `${key.replace(/-/g, "_").toUpperCase()}`;
                let rkey = `{${keyName}}`;
                let tkey = `{TEMPLATE_${key.replace(/-/g, "_").toUpperCase()}}`;
                let val = data[key];
                if (val === undefined || val === null) {
                    val = "";
                }
                let limit = 0;
                while (text.indexOf(rkey) !== -1 && limit < 5) {
                    ++limit;
                    text = text.replaceAll(rkey, val);
                }
                limit = 0;
                while (text.indexOf(tkey) !== -1 && limit < 5) {
                    ++limit;
                    text = text.replaceAll(tkey, val);
                }
            });
            return text;
        }
        /**
         * Resolve a function from a string.
         *
         * @param {string} value - The string containing the function reference.
         * @param {object} context - The context in which to resolve the function.
         * @returns {function}
         */
        resolveFunctionFromString(value, context = window) {
            const t = this;
            const parts = value.split(".");
            if (parts.length === 0) return undefined;
            if (parts[0] === "webui") {
                context = t;
                parts.shift();
            }
            let func = parts.reduce((acc, part) => {
                if (acc && typeof acc === "object" && part in acc) {
                    return acc[part];
                }
                return undefined;
            }, context);
            if (typeof func === "function") {
                return func;
            }
            return null;
        }
        /**
         * Sanitize HTML/Markdown to assure script execution is not included.
         *
         * @param {string} dirty - The string to sanitize.
         * @returns {string}
         */
        sanitize(dirty) {
            if (typeof dirty !== "string") return "";
            const cleanInput = dirty.replace(/\0/g, "");
            const parser = new DOMParser();
            const doc = parser.parseFromString(cleanInput, "text/html");
            const blockedTags = [
                "script",
                "iframe",
                "object",
                "embed",
                "base",
                "head",
                "link",
                "meta",
                "applet",
                "frame",
                "frameset",
                "style",
            ];
            const clean = (node) => {
                const childNodes = Array.from(node.childNodes);
                childNodes.forEach((child) => {
                    if (child.nodeType !== 1) return;
                    const tagName = child.tagName.toLowerCase();
                    if (blockedTags.includes(tagName)) {
                        child.remove();
                        return;
                    }
                    const attrs = Array.from(child.attributes);
                    attrs.forEach((attr) => {
                        const name = attr.name.toLowerCase();
                        const value = attr.value.trim().toLowerCase();
                        if (name.startsWith("on")) {
                            child.removeAttribute(name);
                            return;
                        }
                        if (["href", "src", "action", "data"].includes(name)) {
                            const checkVal = value.replace(
                                /[\s\x00-\x1f]+/g,
                                "",
                            );
                            if (
                                checkVal.startsWith("javascript:") ||
                                checkVal.startsWith("vbscript:")
                            ) {
                                child.removeAttribute(name);
                            }
                        }
                    });
                    clean(child);
                });
            };
            clean(doc.body);
            return doc.body.innerHTML;
        }
        /**
         * Set the main application node.
         *
         * @param {Node} app - The main application node.
         * @returns {undefined}
         */
        setApp(app) {
            appSettings.app = app;
        }
        /**
         * Set global data that elements can subscribe to and JavaScript can access using webui.getData(key).
         *
         * @param {string} key - The key for the global data.
         * @param {any} value - The value for the global data.
         * @returns {undefined}
         */
        setData(key, value) {
            if (!key) return;
            key = key.split(":")[0];
            let sections = key.split(".");
            let baseKey = webui.toSnake(sections[0], "-");
            if (appDataLimit.indexOf(baseKey) !== -1) {
                if (appDataOnce.indexOf(baseKey) !== -1) {
                    webui.log.warn(
                        `${key} is a reserved key and cannot be set again after initialization`,
                    );
                    return;
                }
                appDataOnce.push(baseKey);
            }
            let dataContainer = key.startsWith("session-")
                ? watchedSessionData
                : watchedAppData;
            value = webui.clone(value);
            if (sections.length === 1) {
                key = webui.toSnake(key, "-");
                if (
                    JSON.stringify(dataContainer[key]) === JSON.stringify(value)
                ) {
                    return;
                }
                if (value === null || value === undefined) {
                    delete dataContainer[key];
                } else {
                    dataContainer[key] = value;
                }
            } else {
                let skey = sections.shift();
                skey = webui.toSnake(skey, "-");
                if (!dataContainer[skey]) {
                    dataContainer[skey] = {};
                }
                let segment = dataContainer[skey];
                while (sections.length > 1) {
                    skey = sections.shift();
                    skey = webui.toSnake(skey, "-");
                    if (!segment[skey]) {
                        segment[skey] = {};
                    }
                    segment = segment[skey];
                }
                skey = sections.shift();
                if (JSON.stringify(segment[skey]) === JSON.stringify(value)) {
                    return;
                }
                if (value === null || value === undefined) {
                    delete segment[skey];
                } else {
                    segment[skey] = value;
                }
            }
            Object.keys(map.subs).forEach((skey) => {
                let bkey = skey.split(".")[0];
                if (bkey !== baseKey) return;
                map.subs[skey].forEach((node) => {
                    setDataToEl(node, skey);
                });
            });
            if (["page-title", "page-subtitle"].indexOf(key) !== -1) {
                updatePageTitle();
            }
        }
        /**
         * Set global or session data only if it does not already exist.
         *
         * @param {string|object} key - The data key, or an object of key:value pairs.
         * @param {any} [value] - The value to set if passing a single key.
         * @returns {undefined}
         * @example
         * webui.setDefault('theme-mode', 'dark');
         * webui.setDefault({ 'theme-mode': 'dark', 'sidebar-open': true });
         */
        setDefault(key, value) {
            const t = this;
            if (!key) return;
            if (typeof key === "object" && key !== null) {
                Object.keys(key).forEach((k) => {
                    t.setDefault(k, key[k]);
                });
                return;
            }
            const existing = t.getData(key);
            if (existing === undefined || existing === null) {
                t.setData(key, value);
            }
        }
        /**
         * Query selector first element matching the selector, including those in shadow DOMs.
         *
         * @param {string} selector - The CSS selector to match element.
         * @param {Node} rootNode - The root node to start the search from.
         * @returns {Node}
         */
        querySelector(selector, rootNode = document) {
            return this.querySelectorAll(selector, rootNode)[0];
        }
        /**
         * Query selector all elements matching the selector, including those in shadow DOMs.
         *
         * @param {string} selector - The CSS selector to match elements.
         * @param {Node} rootNode - The root node to start the search from.
         * @returns {array}
         */
        querySelectorAll(selector, rootNode = document) {
            const results = [];
            if (!rootNode || typeof rootNode.querySelectorAll !== "function") {
                return [];
            }
            rootNode.querySelectorAll(selector).forEach((element) => {
                results.push(element);
            });
            rootNode.querySelectorAll("[has-shadow]").forEach((element) => {
                if (element.shadowRoot) {
                    const nestedResults = webui.querySelectorAll(
                        selector,
                        element.shadowRoot,
                    );
                    results.push(...nestedResults);
                }
            });
            if (rootNode.shadowRoot) {
                const nestedResults = webui.querySelectorAll(
                    selector,
                    rootNode.shadowRoot,
                );
                results.push(...nestedResults);
            }
            return results;
        }
        /**
         * Populate missing key:value pairs in data with defaults found in defaultData.
         *
         * @param {object} data - The data object to populate.
         * @param {object} defaultData - The default data object to use for populating missing values.
         * @returns {object}
         */
        setDefaultData(data, defaultData) {
            if (!data || !defaultData) return data;
            defaultData = JSON.parse(JSON.stringify(defaultData));
            Object.keys(defaultData).forEach((key) => {
                if ([undefined, null].indexOf(data[key]) !== -1) {
                    data[key] = defaultData[key];
                }
            });
            return data;
        }
        /**
         * Set flag property (true|false) on node.
         *
         * @param {Node} el - The target node.
         * @param {string} property - The property to set.
         * @param {any} value - The value to set the property to.
         * @returns {undefined}
         */
        setFlag(el, property, value) {
            if (
                [
                    undefined,
                    null,
                    0,
                    false,
                    "false",
                    "null",
                    "undefined",
                    "0",
                ].indexOf(value) !== -1
            ) {
                el[property] = false;
                return false;
            } else {
                el[property] = true;
                return true;
            }
        }
        /**
         * Set property on node.
         *
         * @param {Node} el - The target node.
         * @param {string} property - The property to set.
         * @param {any} value - The value to set the property to.
         * @returns {undefined}
         */
        setProperty(el, property, value) {
            if (
                property !== "value" &&
                (value === null || value === undefined)
            ) {
                delete el[property];
            } else {
                el[property] = value;
            }
            switch (property) {
                case "elevation":
                    webui.removeClass(el, "elevation-");
                    if (value > 0) {
                        el.classList.add(`elevation-${value}`);
                    } else if (value < 0) {
                        el.classList.add(`elevation-n${value * -1}`);
                    }
                    break;
            }
        }
        /**
         * Set the theme color for an element.
         *
         * @param {Node} el - The target element.
         * @param {string} value - primary | secondary | etc
         * @returns {undefined}
         */
        setTheme(el, value) {
            el.style.setProperty("--theme-color", `var(--color-${value})`);
            el.style.setProperty(
                "--theme-color-offset",
                `var(--color-${value}-offset)`,
            );
        }
        /**
         * Check if the target node matches the given check function or string.
         *
         * @param {Node} parent - The parent node.
         * @param {Node} target - The target node.
         * @param {function|string} check - The check function or string.
         * @param {function} onSuccess - The callback function to call on success.
         * @returns {boolean}
         */
        targetMatchesCheck(parent, target, check, onSuccess) {
            while (true) {
                if (!target) return false;
                if (parent === target) return false;
                switch (typeof check) {
                    case "function":
                        if (check(target)) {
                            if (typeof onSuccess === "function") {
                                onSuccess(target);
                            }
                            return true;
                        }
                        break;
                    case "string":
                        if (target.nodeName === check) {
                            if (typeof onSuccess === "function") {
                                onSuccess(target);
                            }
                            return true;
                        }
                        break;
                    default:
                        return false;
                }
                target = target.parentNode || target.host;
            }
        }
        /**
         * Convert to snake case syntax.
         *
         * e.g. this_is_snake_case
         *
         * @param {string} key - The string to convert.
         * @param {string} delim - Delimiter to use between words.
         * @returns {string}
         */
        toSnake(key, delim = "_") {
            return key
                .trim()
                .replace(
                    /[A-Z]{1}/g,
                    (letter) => `${delim}${letter.toLowerCase()}`,
                )
                .replace(/[-_ ]+/g, (_) => delim);
        }
        /**
         * Convert text to camel case syntax.
         *
         * e.g. thisIsCamelCase
         *
         * @param {string} key - The string to convert.
         * @returns {string}
         */
        toCamel(key) {
            return key
                .trim()
                .replace(/((-| )[A-Za-z0-9]{1})/g, (a) => {
                    return a[1].toUpperCase();
                })
                .replace(/^[A-Z]{1}/, (a) => {
                    return a.toLowerCase();
                });
        }
        /**
         * Convert text to pascel case syntax.
         *
         * e.g. ThisIsPascelCase
         *
         * @param {string} key
         * @returns {string}
         */
        toPascel(key) {
            return key
                .trim()
                .replace(/((-| )[A-Za-z0-9]{1})/g, (a) => {
                    return a[1].toUpperCase();
                })
                .replace(/^[a-z]{1}/, (a) => {
                    return a.toUpperCase();
                });
        }
        /**
         * Transfer all children from one node to another.
         *
         * @param {Node} from - The source node.
         * @param {Node} to - The target node.
         * @returns {undefined}
         */
        transferChildren(from, to) {
            let nodes = [];
            from.childNodes.forEach((ch) => {
                nodes.push(ch);
            });
            nodes.forEach((ch) => {
                to.appendChild(ch);
            });
        }
        /**
         * Trim leading whitespace from each line in a block of HTML to shift tabbing.
         *
         * @param {string} html - The HTML content to process.
         * @param {number} tabLength - The number of spaces per tab.
         * @returns {string}
         */
        trimLinePreTabs(html, tabLength = 4) {
            let lines = [],
                ls = 0;
            let tabRepl = webui.repeat(" ", tabLength);
            let startLines = html.replace(/\t/g, tabRepl).split("\n");
            let tabLen = 999;
            let index = 0;
            for (let line of startLines) {
                if (index++ == 0) continue;
                let m = line.match(/^([ ]*)/)[0].length;
                if (m === 0) return html;
                if (m < tabLen) {
                    tabLen = m;
                }
            }
            if (tabLen === 999) {
                tabLen = 0;
            }
            if (tabLen === 0) return html;
            let rgx = new RegExp(`^[ ]{1,${tabLen}}`);
            for (let line of startLines) {
                lines.push(line.replace(rgx, ""));
            }
            return lines.join("\n");
        }
        /**
         * Trim all leading whitespace from each line in a block of HTML.
         *
         * @param {string} html - The HTML content to process.
         * @returns {string}
         */
        trimLinePreWhitespce(html) {
            let lines = [];
            html.split("\n").forEach((l) => {
                lines.push(l.trim());
            });
            return lines.join("\n");
        }
        /**
         * Try-catch wrapper for async functions.
         *
         * @param {function} handler - The async function to execute.
         * @param {function} onError - The callback function to call on error.
         * @param {function} onFinally - The callback function to call on finally.
         * @returns {Promise} Response from handler
         */
        async try(handler, onError, onFinally) {
            if (typeof handler !== "function") {
                console.error(
                    "Invalid handler for webui.try - expecting function",
                    handler,
                    onError,
                );
                return;
            }
            try {
                if (handler.constructor == AsyncFunction) {
                    return await handler();
                } else {
                    return handler();
                }
            } catch (ex) {
                if (typeof onError === "function") {
                    onError(ex);
                }
            } finally {
                if (typeof onFinally === "function") {
                    onFinally();
                }
            }
        }
        /**
         * Solo process handler to ensure only one instance runs at a time.
         *
         * @param {function} handler - The function to execute.
         * @param {function} onError - The callback function to call on error.
         * @returns {Promise} Response from handler
         */
        async trySoloProcess(handler, onError) {
            if (typeof handler !== "function") {
                console.error(
                    "Invalid handler for webui.trySoloProcess - expecting function",
                    handler,
                    onError,
                );
                return;
            }
            if (isProcessing) return;
            isProcessing = true;
            try {
                if (handler.constructor == AsyncFunction) {
                    return await handler();
                } else {
                    return handler();
                }
            } catch (ex) {
                if (typeof onError === "function") {
                    onError(ex);
                }
            } finally {
                isProcessing = false;
            }
        }
        /**
         * Get a Solo process handler that can be called by an event to run handler while ensuring only one solo process instance runs at a time.
         *
         * @param {function} handler - The function to execute.
         * @param {function} onError - The callback function to call on error.
         * @returns {Promise} Response from handler
         */
        eventSoloProcess(handler, onError) {
            if (typeof handler !== "function") {
                console.error(
                    "Invalid handler for webui.eventSoloProcess - expecting function",
                    handler,
                    onError,
                );
                return;
            }
            return async () => {
                if (isProcessing) return;
                isProcessing = true;
                try {
                    if (handler.constructor == AsyncFunction) {
                        return await handler();
                    } else {
                        return handler();
                    }
                } catch (ex) {
                    if (typeof onError === "function") {
                        onError(ex);
                    }
                } finally {
                    isProcessing = false;
                }
            };
        }
        /**
         * Method to load user roles based on the app configuration.
         *
         * @returns {Promise}
         */
        async loadRoles() {
            const t = this;
            if (t.appConfig && t.appConfig.rolesApi) {
                let resp = await t.fetchApi(t.appConfig.rolesApi, null, "get");
                if (resp.status === 200) {
                    let cookieAge =
                        parseInt(resp.headers.get("X-Cookie-Age") || "") || 30;
                    if (cookieAge > 0) {
                        t.setData("session-autosignout", cookieAge);
                    }
                    let r = parseInt(await resp.text());
                    if (r >= -1) {
                        t.setData("session-user-role", r);
                    } else {
                        t.setData("session-user-role", 0);
                    }
                }
            } else {
                console.warn("Cannot load roles, missing configuration.");
            }
        }
        /**
         * Check if user is assigned the given role.
         *
         * See webui.roles for available roles.
         *
         * @param {number} role
         * @returns {boolean} true if user has role assigned, false if not
         */
        hasRole(role) {
            return (this.userRoles & role) === role;
        }
        /**
         * Get mapping of available user roles.
         *
         * @returns {object} Mapping of available user roles
         */
        get roles() {
            return roles;
        }
        /**
         * Get roles assigned to current user.
         *
         * Roles are represented in an integer usign bitwise checks. (e.g. 0=Guest, 1=User, 2=..., 4=..., 8=..., etc.)
         *
         * @returns {number} i32 Integer representing current roles of user.
         */
        get userRoles() {
            return this.getData("session-user-role");
        }
        /**
         * Create a new random UUID.
         *
         * Attempts to use crypto.randomUUID(), falls back to inline method if fails.
         *
         * @returns {string} string representing a new UUID unique identifier.
         */
        uuid() {
            try {
                return crypto.randomUUID();
            } catch (ex) {
                return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
                    /[xy]/g,
                    function (c) {
                        let r = (Math.random() * 16) | 0,
                            v = c == "x" ? r : (r & 0x3) | 0x8;
                        return v.toString(16);
                    },
                );
            }
        }
        /**
         * Create a proxy to watch for changes on a data object and call handler on changes.
         *
         * @param {object} data - The data object to watch.
         * @param {function} handler - The function to call on changes.
         * @returns {string} The proxy instance.
         */
        watchData(data, handler) {
            return new Proxy(data, getHandler(handler));
        }
        /**
         * Pass a function to be called on app data changes.
         *
         * @param {function} handler - The function to call on app data changes.
         * @returns {undefined}
         */
        watchAppDataChanges(handler) {
            notifyForAppDataChanges.push(handler);
        }
        /**
         * Pass a function to be called on session data changes.
         *
         * @param {function} handler - The function to call on session data changes.
         * @returns {undefined}
         */
        watchSessionDataChanges(handler) {
            notifyForSessionDataChanges.push(handler);
        }
        /**
         * Remove a function from being called on app data changes.
         *
         * @param {function} handler - The function to remove.
         * @returns {undefined}
         */
        unwatchAppDataChanges(handler) {
            let index = notifyForAppDataChanges.indexOf(handler);
            if (index === -1) return;
            notifyForAppDataChanges.splice(index, 1);
        }
        /**
         * Remove a function from being called on session data changes.
         *
         * @param {function} handler - The function to remove.
         * @returns {undefined}
         */
        unwatchSessionDataChanges(handler) {
            let index = notifyForSessionDataChanges.indexOf(handler);
            if (index === -1) return;
            notifyForSessionDataChanges.splice(index, 1);
        }
        /**
         * Check to see if a URL is valid.
         *
         * Optionally check for specific protocols.
         *
         * @param {string} url - Url to check if is a valid URL.
         * @param {array} protocols - Protocols to check for - default ['http:','https:']
         * @returns {bool}
         */
        validateUrl(url, protocols = ["http:", "https:"]) {
            try {
                url = new URL(url);
            } catch (_) {
                return false;
            }
            if (!protocols || !protocols.indexOf) return true;
            return protocols.indexOf(url.protocol) !== -1;
        }
        /**
         * Awaitable method to wait for a given time in milliseconds before continuing process.
         *
         * Note: When passing a method, wait will resolve no later than 10 seconds. This is done to avoid waits that go on forever because of batch logic.
         *
         * @param {number|function} milliseconds - milliseconds to wait | Method that returns true|false and flags when the wait can resolve.
         * @returns {Promise}
         */
        wait(milliseconds) {
            return new Promise(async (resolve) => {
                if (typeof milliseconds === "function") {
                    let limit = 0;
                    let result = milliseconds(++limit);
                    while (!result && limit < 100) {
                        await webui.wait(100);
                        result = milliseconds(++limit);
                    }
                    resolve(limit);
                } else {
                    setTimeout(resolve, milliseconds);
                }
            });
        }
    }
    const webui = new WebUI();
    webui
        .fetchWithCache("https://cdn.myfi.ws/roles.json", true)
        .then((r) => {
            Object.assign(roles, r);
            Object.freeze(roles);
        })
        .catch((ex) => {
            webui.log.warn("Failed to load roles: %o", ex);
        });
    //storage_accepted
    function getNodeKey(node) {
        let segments = [];
        segments.push(node.nodeName.toLowerCase());
        if (node.classList.length) {
            segments.push(node.classList[0]);
        }
        ["id", "name"].forEach((attr) => {
            let val = node.attributes[attr];
            if (val && val.value) {
                segments.join(`${attr}-${val.value}`);
            }
        });
        return segments.join("_");
    }
    function saveState(node) {
        let key = getNodeKey(node);
        let state = {};
        node.dataset.state.split("|").forEach((attr) => {
            let val = node.attributes[attr];
            if (val && val.value && val.value !== "undefined") {
                state[attr] = val.value;
            }
        });
        storage.setItem(key, JSON.stringify(state));
    }
    function loadState(node) {
        let key = getNodeKey(node);
        let item = storage.getItem(key);
        if (!item) return;
        let state = JSON.parse(item);
        node.dataset.state.split("|").forEach((attr) => {
            if (state[attr]) {
                node.setAttribute(attr, state[attr]);
            } else {
                node.removeAttribute(attr);
            }
        });
    }
    function checkNodes(nodes) {
        if (nodes.length === 0) return;
        nodes.forEach((node) => {
            checkAddedNode(node);
        });
    }
    function applyDataHide() {
        map.hides.forEach((el) => {
            if (!el.isConnected) return;
            let sel = el.dataset.hide;
            if (!sel) return;
            let found = document.querySelector(sel);
            el.style.display = found ? "" : "none";
        });
    }
    function checkDataStateMutations(mutations) {
        updateActivity();
        mutations.forEach(function (mutation) {
            if (
                mutation.target &&
                mutation.target.dataset &&
                mutation.target.dataset.state
            ) {
                saveState(mutation.target, mutation.attributeName);
            }
            Array.from(mutation.addedNodes).forEach((el) => {
                if (el.dataset && el.dataset.state) {
                    loadState(el);
                }
            });
        });
        applyDataHide();
    }
    // Data signalling/transfers
    function handleDataClick(_) {
        map.subs[key].forEach((sub) => {
            let subAttr = sub.getAttribute("data-subscribe") || "";
            let subscriptions = subAttr.split("|").map((s) => s.trim());
            if (subscriptions.includes(`${key}:click`)) {
                sub.click();
            }
        });
    }
    async function handleDataTrigger(ev) {
        let el = ev.srcElement || ev.target || ev;
        if (ev.composedPath) {
            for (let path of ev.composedPath()) {
                if (
                    path.dataset &&
                    (path.dataset.trigger || path.dataset.bind)
                ) {
                    el = path;
                    break;
                }
            }
        }
        let tick = 0;
        if (
            el.nodeName.startsWith("APP-") ||
            el.nodeName.startsWith("WEBUI-")
        ) {
            while (el._isConnected === undefined && ++tick < 100) {
                await webui.wait(10);
            }
            if (!el._isConnected) {
                webui.log.warn(
                    "Unexpected: Element is not connected",
                    tick,
                    el,
                );
                return;
            }
        }
        let key = [el.dataset.trigger, el.dataset.bind]
            .filter(Boolean)
            .join("|");
        if (!key) return;
        key.split("|").forEach((key) => {
            let oldData = webui.getData(key);
            if (key.indexOf(":") !== -1) {
                let kp = key.split(":");
                key = kp[0];
                let getter = kp[1];
                let value =
                    typeof el[getter] === "function"
                        ? el[getter]()
                        : webui.getDefined(el[getter], el.dataset[getter]);
                if (oldData !== value) {
                    webui.setData(key, value);
                }
            } else {
                let value = webui.getDefined(
                    typeof el.getValue === "function"
                        ? el.getValue()
                        : undefined,
                    el.value,
                    el.dataset.value,
                );
                if (oldData !== value) {
                    webui.setData(key, value);
                }
            }
        });
    }
    function setDataToEl(el, key, value) {
        if (typeof key !== "string") {
            console.error("Invalid key for webui.setDataToEl", key, el);
            return;
        }
        function getToSet(key) {
            let toSet = "setter";
            let combinedAttrs = [el.dataset.subscribe, el.dataset.bind]
                .filter(Boolean)
                .join("|");
            combinedAttrs.split("|").forEach((ds) => {
                let kts = ds.trim().split(":");
                if (!(key === ds || kts[0] === key)) return;
                if (kts.length === 2) {
                    toSet = kts[1];
                }
            });
            return toSet;
        }
        key.split("|").forEach((key) => {
            key = key.trim();
            let toSet = getToSet(key);
            if (toSet === "click") return;
            if (key.indexOf(":") !== -1) {
                key = key.split(":")[0];
            }
            let a = 0;
            (function attempt() {
                try {
                    value = webui.getData(key);
                    let isNull = value === null || value === undefined;
                    if (el.__setdata === undefined) {
                        el.__setdata = {};
                    }
                    let cv =
                        typeof value === "string"
                            ? webui.hashCode(value)
                            : webui.hashCode(JSON.stringify(value));
                    if (el.__setdata[key] === cv) {
                        return;
                    }
                    const pcv = el.__setdata[key];
                    el.__setdata[key] = cv;
                    switch (toSet) {
                        case "setter":
                            let field = webui.toCamel(key);
                            let fsetter = webui.toCamel(`set-${field}`);
                            if (typeof el[fsetter] === "function") {
                                el[fsetter](value, key);
                            } else if (typeof el[field] === "function") {
                                el[field](value, key);
                            } else if (
                                typeof el.setValue === "function" &&
                                a > 1
                            ) {
                                el.setValue(value, key);
                            } else if (
                                ["number", "string", "object"].indexOf(
                                    typeof el[fsetter],
                                ) !== -1
                            ) {
                                el[fsetter] = value;
                            } else if (
                                ["number", "string", "object"].indexOf(
                                    typeof el[field],
                                ) !== -1
                            ) {
                                el[field] = value;
                            } else {
                                if (a++ < 5) {
                                    el.__setdata[key] = pcv;
                                    setTimeout(
                                        () => {
                                            attempt();
                                        },
                                        Math.min(1000, Math.pow(2, a)),
                                    );
                                } else if (webui.hasSetter(el, "value")) {
                                    el.value = value;
                                }
                            }
                            break;
                        case "text":
                        case "innerText":
                            if (!isNull) {
                                el.innerText = webui.applyAppDataToContent(
                                    value,
                                    false,
                                    true,
                                );
                            }
                            break;
                        case "html":
                        case "innerHTML":
                            if (!isNull) {
                                el.innerHTML = webui.applyAppDataToContent(
                                    value,
                                    false,
                                    true,
                                );
                            }
                            break;
                        default:
                            if (typeof el[toSet] === "function") {
                                el[toSet](value, key);
                            } else if (
                                ["number", "string", "object"].indexOf(
                                    typeof el[toSet],
                                ) !== -1
                            ) {
                                el[toSet] = value;
                            } else {
                                if (a++ < 4) {
                                    el.__setdata[key] = pcv;
                                    setTimeout(
                                        () => {
                                            attempt();
                                        },
                                        Math.min(1000, Math.pow(2, a)),
                                    );
                                } else {
                                    switch (toSet) {
                                        case "class":
                                            if (isNull) {
                                                el.classList.remove(value);
                                            } else {
                                                el.classList.add(value);
                                            }
                                            break;
                                        case "src":
                                        case "href":
                                        case "value":
                                        case "style":
                                        case "theme":
                                        case "elevation":
                                        case "slot":
                                            if (isNull) {
                                                el.removeAttribute(toSet);
                                            } else {
                                                el.setAttribute(toSet, value);
                                            }
                                            break;
                                        default:
                                            if (isNull) {
                                                delete el.dataset[toSet];
                                            } else {
                                                el.dataset[toSet] = value;
                                            }
                                            break;
                                    }
                                }
                            }
                            break;
                    }
                } catch (ex) {
                    console.error(
                        `Error setting data to ${el.nodeName}`,
                        el,
                        ex,
                        key,
                    );
                }
            })();
        });
    }
    function toggleAttr(el, attr) {
        if (el.getAttribute(attr)) {
            el.removeAttribute(attr);
        } else {
            el.setAttribute(attr, true);
        }
    }
    function toggleClass(el, cls) {
        if (el.classList.contains(cls)) {
            el.classList.remove(cls);
        } else {
            el.classList.add(cls);
        }
    }
    function removeClass(el, cls) {
        if (el.classList.contains(cls)) {
            el.classList.remove(cls);
        }
    }
    function setAttr(el, attr, val) {
        el.setAttribute(attr, val);
    }
    let currentPageUrl = "-";
    function changePage(url) {
        if (url === currentPageUrl) return;
        currentPageUrl = url;
        const pageState = { appData: JSON.stringify(watchedAppData) };
        window.history.pushState(pageState, document.title, url);
        loadPage(url);
    }
    function updateActivity() {
        lastActive = Date.now();
    }
    function registerNode(node) {
        if (!node || typeof node.getAttribute !== "function") return;
        let def = node.getAttribute("data-default");
        if (def) {
            def.split("|").forEach((pair) => {
                let [defKey, defVal] = pair.split(":");
                if (defKey && defVal !== undefined) {
                    webui.setDefault(defKey.trim(), defVal.trim());
                }
            });
        }
        let sub = node.getAttribute("data-subscribe");
        if (sub) {
            sub.split("|").forEach((dk) => {
                let dataKey = dk.split(":")[0].trim();
                if (!map.subs[dataKey]) map.subs[dataKey] = new Set();
                map.subs[dataKey].add(node);
                setDataToEl(node, dataKey);
            });
        }
        let trig = node.getAttribute("data-trigger");
        if (trig) {
            trig.split("|").forEach((tk) => {
                let triggerKey = tk.split(":")[0].trim();
                if (!map.triggers[triggerKey])
                    map.triggers[triggerKey] = new Set();
                map.triggers[triggerKey].add(node);
            });
        }
        let bind = node.getAttribute("data-bind");
        if (bind) {
            bind.split("|").forEach((bk) => {
                let bindKey = bk.split(":")[0].trim();
                if (!map.subs[bindKey]) map.subs[bindKey] = new Set();
                map.subs[bindKey].add(node);
                setDataToEl(node, bindKey);
                if (!map.triggers[bindKey]) map.triggers[bindKey] = new Set();
                map.triggers[bindKey].add(node);
            });
        }
        let hide = node.getAttribute("data-hide");
        if (hide) {
            map.hides.add(node);
        }
    }
    function unregisterNode(node) {
        const scrubNode = (set) => set.delete(node);
        Object.values(map.subs).forEach(scrubNode);
        Object.values(map.triggers).forEach(scrubNode);
        map.hides.delete(node);
    }

    function unregisterDetachedNodes() {
        const scrubDetached = (set) => {
            set.forEach((el) => {
                if (!el.isConnected) set.delete(el);
            });
        };
        Object.values(map.subs).forEach(scrubDetached);
        Object.values(map.triggers).forEach(scrubDetached);
        scrubDetached(map.hides);
    }

    function checkAttributeMutations(mutation) {
        if (mutation.type !== "attributes") return;
        if (
            mutation.target &&
            mutation.target.nodeName === "INPUT" &&
            mutation.target.getAttribute("type") === "hidden" &&
            mutation.attributeName === "value"
        ) {
            handleDataTrigger(mutation.target);
        }
        const t = mutation.target;
        applyAttributeSettings(t, mutation.attributeName);
    }

    function applyAttributeSettings(target, attr) {
        if (webui.closest(target.parentNode, "webui-code,code,template")) {
            return;
        }
        if (!attr) {
            if (target && typeof target.getAttribute === "function") {
                [
                    "elevation",
                    "theme",
                    "data-subscribe",
                    "data-bind",
                    "data-default",
                    "top",
                    "right",
                    "bottom",
                    "left",
                ].forEach((attr) => {
                    if (target.hasAttribute(attr)) {
                        applyAttributeSettings(target, attr);
                    }
                });
            }
            return;
        }
        let value = target.getAttribute(attr);
        switch (attr) {
            case "top":
                target.style.top = webui.pxIfNumber(value);
                break;
            case "right":
                target.style.right = webui.pxIfNumber(value);
                break;
            case "bottom":
                target.style.bottom = webui.pxIfNumber(value);
                break;
            case "left":
                target.style.left = webui.pxIfNumber(value);
                break;
            case "data-default":
            case "data-bind":
            case "data-subscribe":
                registerNode(target); // Safely handles specific dynamic attribute changes
                break;
            case "elevation":
                webui.removeClass(target, "elevation-");
                value = parseInt(value) || 0;
                if (value > 0) {
                    target.classList.add(`elevation-${value}`);
                } else if (value < 0) {
                    target.classList.add(`elevation-n${value * -1}`);
                }
                break;
            case "theme":
                if (typeof target.setTheme === "function") {
                    target.setTheme(value);
                } else if (value) {
                    target.style.setProperty(
                        "--theme-color",
                        `var(--color-${value})`,
                    );
                    target.style.setProperty(
                        "--theme-color-offset",
                        `var(--color-${value}-offset)`,
                    );
                } else {
                    target.style.removeProperty("--theme-color");
                    target.style.removeProperty("--theme-color-offset");
                }
                break;
        }
    }

    function checkDataSubscriptionMutations(mutations) {
        let needsCleanup = false;
        mutations.forEach(function (mutation) {
            checkAttributeMutations(mutation);
            if (
                mutation.type === "attributes" &&
                [
                    "data-subscribe",
                    "data-trigger",
                    "data-bind",
                    "data-default",
                    "data-hide",
                ].includes(mutation.attributeName)
            ) {
                unregisterNode(mutation.target);
                registerNode(mutation.target);
            }
            if (mutation.removedNodes.length > 0) {
                needsCleanup = true;
            }
        });
        if (needsCleanup) {
            unregisterDetachedNodes();
        }
    }
    function transitionDelay(ms) {
        return new Promise((resolve, _) => {
            setTimeout(() => resolve(), ms);
        });
    }
    function clearPageData() {
        Object.keys(watchedAppData).forEach((key) => {
            let keepKey =
                key.startsWith("app-") ||
                key.startsWith("session-") ||
                ["page-path"].indexOf(key) !== -1;
            if (!keepKey) {
                delete watchedAppData[key];
            }
        });
    }
    async function fetchRemoteData() {
        const pageDataEndpoint = webui.getData("app-data-endpoint");
        if (pageDataEndpoint) {
            let data = await fetch(`${pageDataEndpoint}${dataUrl}`);
            if (!data.ok) {
                webui.log.warn("Returned page data was not ok for %o", dataUrl);
                return {};
            }
            return await data.json();
        }
        return {};
    }
    let currentPage = "";
    let currentHash = "";
    async function applyHash() {
        if (currentHash === location.hash) return;
        currentHash = location.hash;
        if (currentHash === "") return;
        setTimeout(() => {
            if (currentHash !== location.hash) return;
            let el = webui.querySelectorAll(
                `[hash="${currentHash.substring(1)}"]`,
            )[0];
            if (!el) return;
            if (["WEBUI-BUTTON", "BUTTON"].indexOf(el.nodeName) !== -1) {
                el.click();
            } else {
                el.focus();
                el.scrollIntoView({ behavior: "smooth" });
            }
        }, 100);
    }
    async function loadPage() {
        if (!appSettings.app || !webui.appConfig.appName) {
            setTimeout(() => {
                loadPage();
            }, 10);
            return;
        }
        let page =
            location.pathname === "/"
                ? "/" + appSettings.rootPage
                : location.pathname;
        let contentPage = page.toLowerCase();
        if (
            webui.appConfig.dynNavRoutes &&
            webui.appConfig.dynNavRoutes.length
        ) {
            for (
                let index = 0;
                index < webui.appConfig.dynNavRoutes.length;
                ++index
            ) {
                if (
                    contentPage.startsWith(webui.appConfig.dynNavRoutes[index])
                ) {
                    contentPage = webui.appConfig.dynNavRoutes[index];
                    break;
                }
            }
        }
        if (contentPage.endsWith("/")) {
            contentPage = contentPage.substring(0, contentPage.length - 1);
        }
        if (currentPage === contentPage) {
            applyHash();
            return;
        }
        currentPage = contentPage;
        let contentUrl = `${contentPage}${appSettings.contentExtension}${location.search}`;
        if (appSettings.encryptPageContent) {
            contentUrl = encryptUrl(contentUrl, appSettings.encryptPageContent);
        }
        let fullContentUrl = `${webui.getData("app-content-endpoint")}${contentUrl}`;
        let fetchContent = fetch(fullContentUrl);
        let fetchData = fetchRemoteData();
        appSettings.app.main.classList.add("transition");
        webui.setData("page-path", page);
        let timerStart = Date.now();
        try {
            let contentResult = await fetchContent;
            if (!contentResult.ok) {
                throw Error("Returned page content was not ok");
            }
            let body = await contentResult.text();
            let elapsed = Date.now() - timerStart;
            if (elapsed < 300) {
                await transitionDelay(300 - elapsed);
            }
            appSettings.app.setPageContent("", watchedAppData, fullContentUrl);
            clearPageData();
            if (body.startsWith(`<!DOCTYPE`)) {
                let err = new Error(
                    `Invalid page content loaded from ${fullContentUrl}`,
                );
                err.status = 404;
                throw err;
            }
            let content = webui.applyAppDataToContent(body);
            appSettings.app.setPageContent(
                content,
                watchedAppData,
                fullContentUrl,
            );
            setTimeout(() => {
                checkNodes(document.body.childNodes);
                applyHash();
            }, 100);
        } catch (ex) {
            let elapsed = Date.now() - timerStart;
            if (elapsed < 300) {
                await transitionDelay(300 - elapsed);
            }
            clearPageData();
            let fallbackHtml = webui.getData("app-not-found-html");
            if (!fallbackHtml) {
                webui.log.error("Failed loading page content", ex);
                fallbackHtml = "<webui-page-not-found></webui-page-not-found>";
            }
            appSettings.app.setPageContent(fallbackHtml, watchedAppData);
        }
        try {
            let data = await fetchData;
            webui.setData("page-data", data);
            if (!data.forEach) {
                Object.keys(data).forEach((key) => {
                    webui.setData(key, data[key]);
                });
            }
        } catch (ex) {
            console.error("Failed loading page data", ex);
        }
        let elapsed = Date.now() - timerStart;
        if (elapsed < 300) {
            await transitionDelay(300 - elapsed);
        } else {
            await transitionDelay(100);
        }
        appSettings.app.main.classList.remove("transition");
    }
    function encryptUrl(url, encryption) {
        if (!encryption) return url;
        switch (encryption) {
            case "base64":
                return btoa(url);
            default:
                return url;
        }
    }
    // Component Watcher
    const appPrefix = `APP-`;
    const wuiPrefix = `WEBUI-`;
    const wcLoading = {};
    const wcLoaded = {};
    const appLoaded = {};
    const wcRoot = location.port === "3180" ? "" : "https://cdn.myfi.ws/";
    const wcMin = ".min";
    async function processWebUINode(nodeName) {
        nodeName = nodeName.toUpperCase();
        if (wcLoading[nodeName]) return;
        wcLoading[nodeName] = true;
        let wc = nodeName.split("-").splice(1).join("-").toLowerCase();
        if (nodeName.startsWith(appPrefix)) {
            await loadAppComponent(wc).catch(() => {
                delete wcLoading[nodeName];
            });
        } else {
            await loadWebUIComponent(wc).catch(() => {
                delete wcLoading[nodeName];
            });
        }
    }
    async function waitForComponentLoad(name) {
        const prefix = `${name.split("-")[0]}-`;
        const wc = name.split("-").splice(1).join("-").toLowerCase();
        let limit = 0;
        if (prefix.toLowerCase() === appPrefix.toLowerCase()) {
            while (wcLoading[name] && !appLoaded[wc] && limit++ < 1000) {
                await webui.wait(10);
            }
        } else {
            while (wcLoading[name] && !wcLoaded[wc] && limit++ < 1000) {
                await webui.wait(10);
            }
        }
    }
    function loadWebUIComponent(wc) {
        const nodeName = `${wuiPrefix}${wc}`.toUpperCase();
        if (wcLoaded[wc]) return Promise.resolve();
        if (wcLoading[nodeName] instanceof Promise) {
            return wcLoading[nodeName];
        }
        const loadPromise = new Promise(async (resolve, reject) => {
            await waitForComponentLoad(`${wuiPrefix}${wc}`);
            if (wcLoaded[wc]) {
                resolve();
                return;
            }
            let script = webui.create("script");
            script.setAttribute("async", true);
            script.setAttribute("src", `${wcRoot}webui/${wc}${wcMin}.js`);
            script.setAttribute("crossorigin", "anonymous");
            script.onload = () => {
                wcLoaded[wc] = true;
                delete wcLoading[nodeName];
                resolve();
            };
            script.onerror = () => {
                reject(new Error(`Failed to load component: ${wc}`));
            };
            document.head.append(script);
        });
        wcLoading[nodeName] = loadPromise;
        return loadPromise;
    }
    function loadAppComponent(wc) {
        return new Promise(async (resolve, reject) => {
            await waitForComponentLoad(`${appPrefix}${wc}`);
            if (appLoaded[wc]) {
                resolve();
                return;
            }
            let script = webui.create("script");
            script.setAttribute("async", true);
            script.setAttribute(
                "src",
                `${webui.appSrc}/${wc}${webui.appMin}.js`,
            );
            script.setAttribute("crossorigin", "anonymous");
            script.onload = () => {
                appLoaded[wc] = true;
                resolve();
            };
            script.onerror = () => {
                reject(new Error(`Failed to load component: ${wc}`));
            };
            document.head.append(script);
        });
    }
    async function preloadFromAttribute(componentName) {
        if (componentName.toLowerCase().startsWith("app:")) {
            let name = componentName.substring(4);
            await processWebUINode(`${appPrefix}${name}`);
        } else {
            await processWebUINode(`${wuiPrefix}${componentName}`);
        }
    }
    function componentPreload(el) {
        if (!el) return;
        if (
            el.nodeName.startsWith(wuiPrefix) ||
            el.nodeName.startsWith(appPrefix)
        ) {
            processWebUINode(el.nodeName);
        }
        let pl = el.getAttribute("preload");
        if (pl && typeof pl.replace === "function") {
            pl.replaceAll(";", " ")
                .replaceAll(",", " ")
                .split(" ")
                .forEach(preloadFromAttribute);
        }
    }
    async function preloadComponents(pl) {
        if (!pl || typeof pl.replace !== "function") return;
        pl = pl.replaceAll(";", " ").replaceAll(",", " ").split(" ");
        for (let index = 0; index < pl.length; ++index) {
            await preloadFromAttribute(pl[index]).catch((err) =>
                console.error(
                    "Failed to preload from attribute",
                    pl[index],
                    err,
                ),
            );
        }
    }
    function checkMutation(mutation) {
        checkAttributeMutations(mutation);
        let nodeName = mutation.target.nodeName;
        if (
            (nodeName.startsWith(wuiPrefix) ||
                nodeName.startsWith(appPrefix)) &&
            mutation.type === "attributes" &&
            mutation.attributeName === "preload"
        ) {
            componentPreload(mutation.target);
        }
        Array.from(mutation.addedNodes).forEach((el) => {
            checkAddedNode(el);
        });
    }
    function checkAddedNode(el) {
        registerNode(el);
        applyAttributeSettings(el);
        if (el.dataset && el.dataset.state) {
            loadState(el);
        }
        if (el.shadowRoot) {
            if (!el._isObserved) {
                el._isObserved = 1;
                startObserving(el.shadowRoot);
            }
            checkNodes(el.shadowRoot.childNodes);
        }
        if (
            (el.nodeName && el.nodeName.startsWith(wuiPrefix)) ||
            el.nodeName.startsWith(appPrefix)
        ) {
            processWebUINode(el.nodeName);
        }
        checkNodes(el.childNodes);
    }
    const startObserving = (domNode) => {
        const observer = new MutationObserver((mutations) => {
            checkDataStateMutations(mutations);
            checkDataSubscriptionMutations(mutations);
            mutations.forEach(function (mutation) {
                checkMutation(mutation);
            });
        });
        observer.observe(domNode, {
            childList: true,
            attributes: true,
            characterData: true,
            subtree: true,
        });
        return observer;
    };
    let rwrStep = 1;
    function runWhenBodyIsReady(setup) {
        if (!document.body || !webui.loaded) {
            setTimeout(() => runWhenBodyIsReady(setup), rwrStep);
            rwrStep += 1;
            return;
        }
        setup();
    }
    runWhenBodyIsReady(() => {
        checkNodes(document.childNodes);
        applyDataHide();
        webui.querySelectorAll("[theme]").forEach((el) => {
            applyAttributeSettings(el, "theme");
        });
        webui.querySelectorAll("[elevation]").forEach((el) => {
            applyAttributeSettings(el, "elevation");
        });
        ["app-config", "app", "data"].forEach((preload) => {
            componentPreload(document.querySelector(`webui-${preload}`));
        });
        startObserving(document.body);
        loadPage();
        loadWebUIComponent("alert");
        loadWebUIComponent("content");
        document.body.addEventListener("input", handleDataTrigger);
        document.body.addEventListener("change", handleDataTrigger);
        document.body.addEventListener("click", (ev) => {
            let target = ev.composedPath ? ev.composedPath()[0] : ev.target;
            let retValue = true;
            let breakAtEnd = false;
            let applyDynStyles = false;
            function stop() {
                ev.stopPropagation();
                ev.preventDefault();
                retValue = false;
                breakAtEnd = true;
            }
            while (
                !breakAtEnd &&
                target !== document.body &&
                target !== null &&
                target !== undefined
            ) {
                if (!target.hasAttribute) {
                    target = target.parentNode || target.host;
                    continue;
                }
                if (
                    target.hasAttribute &&
                    target.hasAttribute("disabled") &&
                    target.getAttribute("disabled") !== "false" &&
                    !ev.ctrlKey
                ) {
                    ev.stopPropagation();
                    ev.preventDefault();
                    return false;
                }
                if (target.dataset.click) {
                    stop();
                    handleDataClick(target);
                }
                if (
                    target.dataset.trigger &&
                    ["A", "BUTTON", "WEBUI-BUTTON"].indexOf(target.nodeName) !==
                        -1
                ) {
                    stop();
                    handleDataTrigger(target);
                }
                let href = target.getAttribute("href");
                if (
                    href &&
                    href.indexOf(":") !== -1 &&
                    href.substr(0, 4) !== "http"
                ) {
                    return true;
                }
                if (
                    href &&
                    target.getAttribute("target") !== "blank" &&
                    (href[0] === "/" || href.substr(0, 4) !== "http")
                ) {
                    stop();
                    changePage(href);
                }
                if (target.hasAttribute("data-stopclick")) {
                    stop();
                }
                if (target.dataset.setattr) {
                    let [val, attr, sel] = target.dataset.setattr
                        .split("|")
                        .reverse();
                    if (sel) {
                        webui.querySelectorAll(sel).forEach((el) => {
                            setAttr(el, attr, val);
                        });
                    } else {
                        setAttr(target, attr, val);
                    }
                    applyDynStyles = true;
                    break;
                }
                if (target.dataset.toggleclass) {
                    let [cls, sel] = target.dataset.toggleclass
                        .split("|")
                        .reverse();
                    if (sel) {
                        webui
                            .querySelectorAll(sel)
                            .forEach((el) => toggleClass(el, cls));
                    } else {
                        toggleClass(target, cls);
                    }
                    applyDynStyles = true;
                    break;
                }
                if (target.dataset.removeclass) {
                    target.dataset.removeclass.split(";").forEach((ds) => {
                        let [cls, sel] = ds.split("|").reverse();
                        if (sel) {
                            webui
                                .querySelectorAll(sel)
                                .forEach((el) => removeClass(el, cls));
                        } else {
                            removeClass(target, cls);
                        }
                    });
                    applyDynStyles = true;
                }
                if (target.dataset.toggleattr) {
                    let [attr, sel] = target.dataset.toggleattr
                        .split("|")
                        .reverse();
                    if (sel) {
                        webui
                            .querySelectorAll(sel)
                            .forEach((el) => toggleAttr(el, attr));
                    } else {
                        toggleAttr(target, attr);
                    }
                    applyDynStyles = true;
                }
                if (applyDynStyles) {
                    webui.applyDynamicStyles();
                    break;
                }
                target = target.parentNode || target.host;
            }
            return retValue;
        });
    });
    window.addEventListener("keydown", updateActivity);
    window.addEventListener("click", updateActivity);
    window.addEventListener("scroll", updateActivity);
    window.addEventListener("popstate", (ev) => {
        changePage(`${location.pathname}${location.hash}${location.search}`);
        if (ev.state) {
            if (ev.state.appData) {
                const appData = JSON.parse(ev.state.appData);
                Object.keys(appData).forEach((key) => {
                    if (
                        ["page-path", "page-title", "page-subtitle"].indexOf(
                            key,
                        ) !== -1
                    )
                        return;
                    watchedAppData[key] = appData[key];
                });
                Object.keys(watchedAppData).forEach((key) => {
                    if (Object.keys(appData).indexOf(key) !== -1) return;
                    delete watchedAppData[key];
                });
            }
        }
    });
    window.addEventListener("load", () => {
        // const FIVE_MINUTES_MS = 5 * 60 * 1000;
        // let lastError = {};
        function buildMessage(event) {
            let msg = [];
            if (event.message) {
                msg.push(event.message);
            }
            if (event.reason) {
                msg.push(`Reason: ${event.reason}`);
            }
            if (event.filename) {
                msg.push(`Source: ${event.filename}`);
            }
            if (event.lineno) {
                msg.push(event.lineno);
            }
            if (event.colno) {
                msg.push(event.colno);
            }
            if (msg.length === 0) return null;
            return `Unhandled Error: ${msg.join(":")}`;
        }
        function errorHandler(event) {
            if (event.promise) {
                return true;
            }
            event.preventDefault();
            const message = buildMessage(event);
            if (!message) return true;
            console.error(event.error || event.reason || event);
            webui.alert(message, "danger");
            return true;
        }
        window.addEventListener("error", errorHandler);
        window.addEventListener("unhandledrejection", errorHandler);
    });
    window.throwTestError = () => {
        throw new Error("This is a simulated uncaught error!");
    };
    let resizeTimer;
    window.addEventListener("resize", (ev) => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            webui.applyDynamicStyles();
            Object.keys(resizeSubscribers).forEach((key) => {
                resizeSubscribers[key](ev);
            });
        }, 150);
    });
    webui.applyDynamicStyles();
    setTimeout(() => webui.applyDynamicStyles(), 1000);
    return webui;
})();

setTimeout(() => {
    if (window.tooltipsEnabled === undefined) {
        window.tooltipsEnabled = true;
    }
    const Tooltip = webui.create("div");
    Tooltip.className = "tooltip closed";
    let capturedElement = null;
    document.body.appendChild(Tooltip);
    let isShowing = false;
    function CloseIfOpen() {
        if (!isShowing) {
            return;
        }
        isShowing = false;
        capturedElement = null;
        Tooltip.className = "tooltip closed";
    }
    function CheckContainersForAriaLabel(target) {
        while (target && target !== target.parentNode) {
            if (!target.getAttribute) {
                target = target.parentNode || target.host;
                continue;
            }
            let title = target.getAttribute("title");
            if (title && title != "null") {
                target.setAttribute("aria-label", title);
                target.removeAttribute("title");
            } else if (title === "null") {
                target.removeAttribute("title");
            }
            let ariaLabel = target.getAttribute("aria-label");
            if (ariaLabel) {
                return [target, ariaLabel];
            }
            target = target.parentNode || target.host;
        }
        return [null, null];
    }
    let tooltipDistancePadding = 30;
    document.body.addEventListener("click", CloseIfOpen);
    document.body.addEventListener("input", CloseIfOpen);
    let isTooltipTicking = false;
    document.body.addEventListener("mousemove", (ev) => {
        if (!window.tooltipsEnabled || isTooltipTicking) return;
        isTooltipTicking = true;
        const eventTarget = ev.composedPath ? ev.composedPath()[0] : ev.target;
        requestAnimationFrame(() => {
            try {
                let [target, display] =
                    CheckContainersForAriaLabel(eventTarget);
                if (!target) {
                    CloseIfOpen();
                    return;
                }
                if (target === capturedElement) {
                    return;
                }
                let client = target.getBoundingClientRect();
                isShowing = true;
                let targetDisplay = `${target.innerText}`.trim();
                if (
                    targetDisplay === display &&
                    !webui.isTextOverflowing(target)
                ) {
                    return;
                }
                capturedElement = target;
                Tooltip.innerText = display;
                Tooltip.className = "tooltip open";
                let myposition = {
                    x: client.left + client.width / 2 - Tooltip.clientWidth / 2,
                    y: client.top - tooltipDistancePadding,
                };
                if (myposition.x + Tooltip.clientWidth > window.innerWidth) {
                    myposition.x = window.innerWidth - Tooltip.clientWidth - 10;
                }
                if (myposition.x < 0) {
                    myposition.x = 10;
                }
                if (myposition.y < 0) {
                    myposition.y = client.top + client.height;
                }

                Tooltip.style.left = `${myposition.x}px`;
                Tooltip.style.top = `${myposition.y}px`;
            } finally {
                isTooltipTicking = false;
            }
        });
    });
}, 100);
