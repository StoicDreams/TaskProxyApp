import { test, expect, openApp, calls } from '../support/app.mjs';

// The webview's own Copy Image leaves nothing to paste on Wayland, so right-clicking an image offers a Copy image that
// copies through Rust (services/clipboard.rs).

const alerts = page => page.evaluate(() => window.__alerts);

async function showImage(page, src) {
    await openApp(page);
    await page.evaluate(src => {
        const img = document.createElement('img');
        img.id = 'shot';
        img.alt = 'Shot';
        img.src = src;
        document.querySelector('webui-app').append(img);
    }, src);
    // Records the messages shown with webui.alert, which alerts() returns.
    await page.evaluate(() => {
        window.__alerts = [];
        const original = webui.alert;
        webui.alert = function (...args) { window.__alerts.push(`${args[0]}`); return original.apply(this, args); };
    });
    const img = page.locator('#shot');
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate(el => el.complete && el.naturalWidth)).toBeGreaterThan(0);
    return img;
}

const pngOf = (page, width, height) => page.evaluate(([width, height]) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').fillRect(0, 0, width, height);
    return canvas.toDataURL('image/png');
}, [width, height]);

test('right-clicking an image offers Copy image, which sends its pixels to Rust', async ({ page }) => {
    await openApp(page);
    const img = await showImage(page, await pngOf(page, 40, 30));
    await img.click({ button: 'right' });
    const copy = page.getByRole('menuitem', { name: 'Copy image' });
    await expect(copy).toBeFocused();
    await copy.click();
    await expect(copy).toHaveCount(0);
    await expect.poll(() => alerts(page)).toContain('Copied the image.');
    expect(await calls(page, 'copy_image')).toHaveLength(1);
    const copied = await page.evaluate(async () => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(window.__backend.clipboard.bytes)]));
        return [bitmap.width, bitmap.height];
    });
    expect(copied).toEqual([40, 30]);
});

test('an image from a website is downloaded by Rust, by its address', async ({ page }) => {
    const shot = await (async () => { await openApp(page); return pngOf(page, 8, 8); })();
    await page.route('https://images.example.com/shot.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(shot.split(',')[1], 'base64') }));
    const img = await showImage(page, 'https://images.example.com/shot.png');
    await img.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy image' }).click();
    await expect.poll(() => page.evaluate(() => window.__backend.clipboard)).toEqual({ url: 'https://images.example.com/shot.png' });
    expect(await calls(page, 'copy_image')).toHaveLength(0);
});

test('Escape or a click elsewhere closes the menu without copying, and other right-clicks keep the usual menu', async ({ page }) => {
    const img = await showImage(page, await (async () => { await openApp(page); return pngOf(page, 10, 10); })());
    const menu = page.locator('.app-image-menu');
    await img.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await img.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(menu).toHaveCount(0);
    // Right-clicking anything else, or Shift with the right click, leaves the webview's menu alone.
    const prevented = await page.evaluate(() => {
        const results = [];
        const listen = ev => results.push(ev.defaultPrevented);
        window.addEventListener('contextmenu', listen);
        const fire = (target, shiftKey) => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, shiftKey }));
        fire(document.querySelector('webui-app'), false);
        fire(document.getElementById('shot'), true);
        window.removeEventListener('contextmenu', listen);
        return results;
    });
    expect(prevented).toEqual([false, false]);
    await expect(menu).toHaveCount(0);
    expect(await calls(page, 'copy_image')).toHaveLength(0);
});
