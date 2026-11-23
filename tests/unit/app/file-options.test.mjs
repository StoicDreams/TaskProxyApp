import { test, expect, openApp } from '../support/app.mjs';

// fileOptions (root_files/app.js) makes a webui-select's options from paths.
test('files are shown by name with their path as the tooltip, and names two paths share add their folder', async ({ page }) => {
    await openApp(page);
    const options = await page.evaluate(() => fileOptions(['PowerShell/Release/Publish.ps1', 'build.ps1', 'docs/README.md', 'README.md', 'a\\b\\c.ps1'], path => ({ icon: path.endsWith('.md') ? 'file' : '' })));
    expect(options).toEqual([
        { id: 'PowerShell/Release/Publish.ps1', value: 'PowerShell/Release/Publish.ps1', display: 'Publish.ps1', title: 'PowerShell/Release/Publish.ps1', icon: '' },
        { id: 'build.ps1', value: 'build.ps1', display: 'build.ps1', title: 'build.ps1', icon: '' },
        { id: 'docs/README.md', value: 'docs/README.md', display: 'README.md (docs)', title: 'docs/README.md', icon: 'file' },
        { id: 'README.md', value: 'README.md', display: 'README.md', title: 'README.md', icon: 'file' },
        { id: 'a\\b\\c.ps1', value: 'a\\b\\c.ps1', display: 'c.ps1', title: 'a\\b\\c.ps1', icon: '' },
    ]);
});
