import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const siteRoot = resolve(ROOT, '../../Websites/TaskProxy/webapp/root_files');

/**
 * Where images and videos are written. Defaults to the TaskProxy website checkout next to this repo,
 * which the site serves as /img/tutorials and /video.
 */
export const OUT = process.env.CAPTURE_OUT || (existsSync(siteRoot) ? siteRoot : join(ROOT, 'test-results', 'capture-media'));
const imageDir = join(OUT, 'img', 'tutorials');
const videoDir = join(OUT, 'video');

/** Adds the pointer and caption overlays. Call before openApp. */
export async function prepare(page) {
    await page.addInitScript(() => {
        const install = () => {
            if (document.getElementById('capture-cursor')) return;
            const style = document.createElement('style');
            style.textContent = `
#capture-cursor { position: fixed; z-index: 2147483647; left: -40px; top: -40px; width: 22px; height: 22px; pointer-events: none;
    transform: translate(-3px, -2px); filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
#capture-cursor.down::after { content: ''; position: absolute; left: -11px; top: -11px; width: 40px; height: 40px; border-radius: 50%;
    border: 3px solid #ffd54a; animation: capture-click .45s ease-out forwards; }
@keyframes capture-click { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.2); opacity: 0; } }
#capture-caption { position: fixed; z-index: 2147483646; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: 80%;
    padding: 12px 22px; border-radius: 10px; background: rgba(10, 14, 30, .88); color: #fff; font: 600 22px/1.35 system-ui, sans-serif;
    text-align: center; box-shadow: 0 4px 18px rgba(0,0,0,.45); pointer-events: none; opacity: 0; transition: opacity .25s; }
#capture-caption.show { opacity: 1; }`;
            document.head.appendChild(style);
            const cursor = document.createElement('div');
            cursor.id = 'capture-cursor';
            cursor.innerHTML = `<svg viewBox="0 0 22 22" width="22" height="22"><path d="M2 1 L2 18 L6.5 14 L9.5 21 L12.5 19.8 L9.6 13 L16 13 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
            document.body.appendChild(cursor);
            const caption = document.createElement('div');
            caption.id = 'capture-caption';
            document.body.appendChild(caption);
            const move = ev => {
                cursor.style.left = `${ev.clientX}px`;
                cursor.style.top = `${ev.clientY}px`;
            };
            window.addEventListener('mousemove', move, true);
            window.addEventListener('mousedown', ev => {
                move(ev);
                cursor.classList.remove('down');
                void cursor.offsetWidth;
                cursor.classList.add('down');
            }, true);
        };
        if (document.body) install();
        else document.addEventListener('DOMContentLoaded', install);
    });
}

/** Hides the overlays, for still screenshots. */
export function hideOverlays(page) {
    return page.evaluate(() => {
        for (const id of ['capture-cursor', 'capture-caption']) document.getElementById(id)?.remove();
    });
}

/** Shows a caption over the bottom of the screen, or hides it when text is empty. */
export async function caption(page, text, hold = 0) {
    await page.evaluate(text => {
        const el = document.getElementById('capture-caption');
        if (!el) return;
        if (text) el.textContent = text;
        el.classList.toggle('show', !!text);
    }, text);
    if (hold) await page.waitForTimeout(hold);
}

let mouse = { x: 720, y: 450 };
/** Glides the pointer to the middle of an element, so viewers can follow it. */
export async function moveTo(page, locator, { steps = 22, offsetX = 0, offsetY = 0 } = {}) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error('Element has no box to move to');
    const x = box.x + box.width / 2 + offsetX;
    const y = box.y + box.height / 2 + offsetY;
    await page.mouse.move(x, y, { steps });
    mouse = { x, y };
    return { x, y };
}

/** Moves to an element, pauses so the viewer sees where, then clicks it. */
export async function clickOn(page, locator, options = {}) {
    const { x, y } = await moveTo(page, locator, options);
    await page.waitForTimeout(options.pause ?? 250);
    await page.mouse.click(x, y);
    await page.waitForTimeout(options.after ?? 400);
}

/** Types into an input at a readable speed. */
export async function typeInto(page, locator, text, { delay = 45 } = {}) {
    await clickOn(page, locator, { after: 150 });
    await page.keyboard.type(text, { delay });
}

/** Starts the pointer somewhere sensible, so the first move does not come from a corner. */
export async function parkMouse(page, x = 820, y = 520) {
    await page.mouse.move(x, y);
    mouse = { x, y };
}

/**
 * Makes start_script play back the given output, as a running script would. Each step is text to write,
 * `{ wait }` milliseconds to pause, or `{ prompt }` to wait until something is typed and Enter is pressed.
 * Typed keys are echoed, as a terminal does.
 */
export async function scriptOutput(page, steps, { code = 0 } = {}) {
    await page.evaluate(({ steps, code }) => {
        const backend = window.__backend;
        const emit = (terminalId, data) => backend.emit('terminal-data', { projectId: webui.projectData.id, terminalId, data });
        let waiting = null;
        backend.handlers.write_terminal_input = ({ terminalId, data }) => {
            if (!waiting || waiting.terminalId !== terminalId) return null;
            for (const ch of data) {
                if (ch === '\r') {
                    emit(terminalId, '\r\n');
                    const resume = waiting.resume;
                    waiting = null;
                    resume();
                    return null;
                }
                if (ch === '\x7f') emit(terminalId, '\b \b');
                else emit(terminalId, ch);
            }
            return null;
        };
        backend.handlers.start_script = ({ terminalId }) => {
            (async () => {
                for (const step of steps) {
                    if (typeof step === 'string') {
                        emit(terminalId, step);
                        await new Promise(r => setTimeout(r, 60));
                    } else if (step.wait) {
                        await new Promise(r => setTimeout(r, step.wait));
                    } else if (step.prompt) {
                        emit(terminalId, step.prompt);
                        await new Promise(resume => { waiting = { terminalId, resume }; });
                    }
                }
                backend.emit('terminal-finished', { projectId: webui.projectData.id, terminalId, code });
            })();
            return { message: 'Script started', interactive: true };
        };
    }, { steps, code });
}

function ffmpeg(args) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

/**
 * Saves a screenshot as WebP. Pass `locator` to capture one element, or `clip` for an area.
 * `dir` is the folder under img, such as plugins/jira, and defaults to tutorials.
 */
export async function shot(page, name, { locator, clip, fullPage, dir } = {}) {
    const folder = dir ? join(OUT, 'img', dir) : imageDir;
    mkdirSync(folder, { recursive: true });
    const work = mkdtempSync(join(tmpdir(), 'tp-shot-'));
    const png = join(work, `${name}.png`);
    // Tooltips from the last hover would cover what the screenshot is meant to show.
    await page.evaluate(() => {
        window.tooltipsEnabled = false;
        document.querySelectorAll('.tooltip').forEach(el => { el.className = 'tooltip closed'; });
    });
    await page.waitForTimeout(350);
    if (locator) await locator.screenshot({ path: png, animations: 'disabled' });
    else await page.screenshot({ path: png, clip, fullPage, animations: 'disabled' });
    ffmpeg(['-i', png, '-c:v', 'libwebp', '-quality', '90', '-compression_level', '6', join(folder, `${name}.webp`)]);
    rmSync(work, { recursive: true, force: true });
}

/**
 * Records the page from Chrome's screencast, which is far sharper than Playwright's built-in video,
 * and encodes it as H.264 MP4 with a WebP poster of its last frame. `dir` is the folder under OUT, which defaults
 * to video.
 */
export async function record(page, name, action, { width = 1280, dir } = {}) {
    const folder = dir ? join(OUT, dir) : videoDir;
    mkdirSync(folder, { recursive: true });
    const work = mkdtempSync(join(tmpdir(), 'tp-video-'));
    const cdp = await page.context().newCDPSession(page);
    const frames = [];
    cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
        frames.push({ data, time: metadata.timestamp });
        await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => { });
    });
    const viewport = page.viewportSize();
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
    try {
        await action();
        await page.waitForTimeout(600);
    } finally {
        await cdp.send('Page.stopScreencast').catch(() => { });
        await cdp.detach().catch(() => { });
    }
    if (frames.length < 2) throw new Error(`Recording ${name} captured no frames`);
    // Frames only arrive when something changes, so each one lasts until the next.
    const list = [];
    frames.forEach((frame, index) => {
        const file = join(work, `f${String(index).padStart(5, '0')}.jpg`);
        writeFileSync(file, Buffer.from(frame.data, 'base64'));
        const next = frames[index + 1];
        const duration = next ? Math.max(0.001, next.time - frame.time) : 0.5;
        list.push(`file '${file}'`, `duration ${duration.toFixed(4)}`);
    });
    list.push(`file '${join(work, `f${String(frames.length - 1).padStart(5, '0')}.jpg`)}'`);
    const listFile = join(work, 'frames.txt');
    writeFileSync(listFile, list.join('\n'));
    const mp4 = join(folder, `${name}.mp4`);
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-vf', `fps=30,scale=${width}:-2:flags=lanczos,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-movflags', '+faststart', '-an', mp4]);
    // The poster is the last frame, which shows the result of the steps.
    ffmpeg(['-sseof', '-0.3', '-i', mp4, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '85', join(folder, `${name}.webp`)]);
    rmSync(work, { recursive: true, force: true });
    return mp4;
}

/**
 * Records a short loop for a website, in place of a screenshot, showing an action from start to finish. It holds
 * the first and last frames a moment, so the loop's restart is easy to follow, and its last frame is the poster.
 * Saved as video/loops/<name>.mp4, or under `dir`.
 */
export async function loop(page, name, action, { dir = 'video/loops', width = 1280 } = {}) {
    await page.evaluate(() => {
        window.tooltipsEnabled = false;
        document.querySelectorAll('.tooltip').forEach(el => { el.className = 'tooltip closed'; });
    });
    return record(page, name, async () => {
        await page.waitForTimeout(700);
        await action();
        await page.waitForTimeout(1600);
    }, { dir, width });
}

export function ensureDir(file) {
    mkdirSync(dirname(file), { recursive: true });
}
