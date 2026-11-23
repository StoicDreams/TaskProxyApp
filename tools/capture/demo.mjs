/**
 * A made-up project used for the website's screenshots and videos. Nothing here is real: the names,
 * hosts, and values only need to look like a typical team repository.
 */

/** A unified diff of two texts, in the form the backend's get_git_file_diff returns. */
export function unifiedDiff(file, before, after) {
    const a = before.split('\n');
    const b = after.split('\n');
    // Longest common subsequence, which is plenty for files this small.
    const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const lines = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            lines.push(` ${a[i]}`);
            i++;
            j++;
        } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
            lines.push(`+${b[j]}`);
            j++;
        } else {
            lines.push(`-${a[i]}`);
            i++;
        }
    }
    return [
        `diff --git a/${file} b/${file}`,
        `--- a/${file}`,
        `+++ b/${file}`,
        `@@ -1,${a.length} +1,${b.length} @@`,
        ...lines,
        '',
    ].join('\n');
}

/** Counts of added and removed lines, as get_git_change_stats reports them. */
function lineStats(path, diff) {
    const lines = diff.split('\n').slice(4);
    return {
        path,
        additions: lines.filter(line => line.startsWith('+')).length,
        deletions: lines.filter(line => line.startsWith('-')).length,
        binary: false,
    };
}

const pages = {
    onboarding: '3f1c2a9e-6b1d-4c55-9d3a-1a7e0c2b5f01',
    release: '7a4e8b10-2c3d-4f6a-8e9b-0c1d2e3f4a02',
    health: 'b5d6e7f8-9a0b-4c1d-8e2f-3a4b5c6d7e03',
    deploy: 'c8d9e0f1-a2b3-4c5d-9e6f-7a8b9c0d1e04',
};
export const PAGE_IDS = pages;

const onboardingPage = `<webui-data data-page-title="Team Onboarding" data-page-subtitle="Get set up on Acme Storefront"></webui-data>

### Welcome to the team

<webui-page-segment>

This page lives in the repository at \`.taskproxy/pages\`, so everyone who opens the project in Task Proxy sees the same steps. Edit it like any other doc, and commit the change for the rest of the team.

1. Ask your lead for access to the **Acme** GitHub organization.
2. Set your \`github_pat\` variable on the **Variables** tab of **Tools** so Task Proxy can push and pull.
3. Run the steps below, top to bottom.

</webui-page-segment>

### Install the tools

<webui-page-segment>

Installs the packages the storefront needs. Run it again whenever \`package.json\` changes.

\`\`\`pwsh
npm install
\`\`\`

</webui-page-segment>

### Point the app at your environment

<webui-page-segment>

The API address comes from the **apiBaseUrl** variable, so switching environments on the **Variables** tab changes what this script writes.

\`\`\`pwsh
$apiBaseUrl = 'https://dev.api.acme.test'
Set-Content .env.local "API_BASE_URL=$apiBaseUrl"
Write-Host "Using $apiBaseUrl" -ForegroundColor Green
\`\`\`

</webui-page-segment>

### Start the storefront

<webui-page-segment>

\`\`\`pwsh
npm run dev
\`\`\`

</webui-page-segment>
`;

const releasePage = `<webui-data data-page-title="Release Checklist" data-page-subtitle="Ship a new version of the storefront"></webui-data>

### Before you release

<webui-page-segment>

- All tests pass on \`main\`.
- The changelog lists every **Feature** and **Bug** since the last release.
- Product has signed off on the release notes.

</webui-page-segment>

### Run the tests

<webui-page-segment>

\`\`\`pwsh
npm test
\`\`\`

</webui-page-segment>

### Bump the version

<webui-page-segment>

\`\`\`pwsh
$releaseType = 'patch'
npm version $releaseType --no-git-tag-version
\`\`\`

</webui-page-segment>
`;

const healthPage = `<webui-data data-page-title="Health Check" data-page-subtitle="Is the storefront up?"></webui-data>

### Check every service

<webui-page-segment>

\`\`\`pwsh
$apiBaseUrl = 'https://dev.api.acme.test'
Invoke-RestMethod "$apiBaseUrl/health"
\`\`\`

</webui-page-segment>
`;

const deployPage = `<webui-data data-page-title="Deploy" data-page-subtitle="Publish to an environment"></webui-data>

### Deploy the current branch

<webui-page-segment>

\`\`\`pwsh
$environment = 'dev'
$deployToken = ''
./scripts/deploy.ps1 -Environment $environment -Token $deployToken
\`\`\`

</webui-page-segment>
`;

const testScript = `<#
.SYNOPSIS
Runs the storefront test suites.
#>
[CmdletBinding()]
param(
    [ValidateSet('unit', 'e2e', 'all')]
    [string]$Suite = 'unit',
    [string]$Filter = '',
    [switch]$Watch
)

$args = @('run', "test:$Suite")
if ($Filter) { $args += @('--', '-g', $Filter) }
if ($Watch) { $args += '--watch' }

Write-Host "Running $Suite tests" -ForegroundColor Cyan
npm @args
`;

const deployScript = `[CmdletBinding()]
param(
    [ValidateSet('dev', 'staging', 'prod')]
    [string]$Environment = 'dev',
    [string]$Token,
    [switch]$SkipBuild
)

$answer = Read-Host "Deploy the current branch to $Environment? [y/N]"
if ($answer -ne 'y') { Write-Host 'Cancelled'; exit 1 }

if (-not $SkipBuild) { npm run build }
Write-Host "Deploying to $Environment" -ForegroundColor Cyan
./tools/publish.ps1 -Target $Environment -Token $Token
`;

const cleanScript = `# Removes build output and caches.
Remove-Item -Recurse -Force dist, .cache -ErrorAction SilentlyContinue
Write-Host 'Clean' -ForegroundColor Green
`;

const readmeBefore = `# Acme Storefront

The web storefront for Acme, built with Vite.

## Getting started

1. Install Node 22.
2. Run \`npm install\`.
3. Run \`npm run dev\`.

## Scripts

| Script | What it does |
|---|---|
| \`npm run dev\` | Starts the dev server |
| \`npm test\` | Runs the unit tests |`;

const readmeAfter = `# Acme Storefront

The web storefront for Acme, built with Vite.

## Getting started

Open this repository in [Task Proxy](https://www.taskproxy.com) and follow the **Team Onboarding** page.
It installs the tools and points the app at your environment for you.

## Scripts

| Script | What it does |
|---|---|
| \`npm run dev\` | Starts the dev server |
| \`npm test\` | Runs the unit tests |
| \`npm run test:e2e\` | Runs the browser tests |`;

const cartBefore = `export function cartTotal(items) {
    let total = 0;
    for (const item of items) {
        total += item.price;
    }
    return total;
}`;

const cartAfter = `export function cartTotal(items, discount = 0) {
    let total = 0;
    for (const item of items) {
        total += item.price * item.quantity;
    }
    return Math.max(0, total - discount);
}`;

const checkoutTest = `import { test, expect } from 'vitest';
import { cartTotal } from '../src/cart.js';

test('quantities count toward the total', () => {
    expect(cartTotal([{ price: 5, quantity: 2 }])).toBe(10);
});

test('a discount never makes the total negative', () => {
    expect(cartTotal([{ price: 5, quantity: 1 }], 20)).toBe(0);
});`;

const navBefore = `{
  "links": ["Home", "Shop", "Cart"]
}`;

const navAfter = `{
  "links": ["Home", "Shop", "Deals", "Cart"]
}`;

const readmeDiff = unifiedDiff('README.md', readmeBefore, readmeAfter);
const cartDiff = unifiedDiff('src/cart.js', cartBefore, cartAfter);
const navDiff = unifiedDiff('src/nav.json', navBefore, navAfter);

export const PROJECT = { name: 'Acme Storefront', path: '/home/sam/code/acme-storefront' };

/** Backend state for openApp, describing the demo project. */
/**
 * The Task Manager's processes: a dev server in an editor's terminal, a Storybook server left running after its
 * terminal closed, and the usual desktop processes around them.
 */
export function demoProcesses() {
    const now = Math.floor(Date.now() / 1000);
    const MB = 1024 * 1024;
    const home = '/home/sam';
    const proc = (pid, parent, name, extra = {}) => ({
        pid, parent, name, command: name, exe: `/usr/bin/${name}`, folder: home, started: now - 5400, cpu: 0.1, memory: 40 * MB,
        status: 'Sleeping', ports: [], terminal: false, orphan: false, taskProxy: false, project: null, ...extra,
    });
    const storefront = `${home}/code/acme-storefront`;
    const design = `${home}/code/design-system`;
    return [
        proc(1000, null, 'systemd', { command: '/usr/lib/systemd/systemd --user', exe: '/usr/lib/systemd/systemd', started: now - 30000 }),
        proc(1100, 1000, 'pipewire', { started: now - 29900, memory: 18 * MB }),
        proc(1150, 1000, 'firefox', { cpu: 3.2, memory: 1450 * MB, started: now - 20000 }),
        proc(1200, 1000, 'code', { command: 'code', cpu: 1.8, memory: 620 * MB, folder: storefront, project: 'Acme Storefront', started: now - 9000 }),
        proc(1210, 1200, 'bash', { folder: storefront, project: 'Acme Storefront', started: now - 8900 }),
        proc(1220, 1210, 'node', { command: 'node node_modules/.bin/vite --port 5173', folder: storefront, project: 'Acme Storefront', terminal: true, ports: [5173], cpu: 0.6, memory: 210 * MB, started: now - 8800 }),
        proc(1230, 1220, 'esbuild', { command: 'esbuild --service --ping', folder: storefront, project: 'Acme Storefront', terminal: true, memory: 24 * MB, started: now - 8790 }),
        proc(1300, 1000, 'node', { command: 'node node_modules/.bin/storybook dev -p 6006', folder: design, project: 'Design System', terminal: true, orphan: true, ports: [6006], cpu: 4.1, memory: 540 * MB, started: now - 26000 }),
        proc(1310, 1300, 'esbuild', { command: 'esbuild --service --ping', folder: design, project: 'Design System', terminal: true, orphan: false, memory: 22 * MB, started: now - 25990 }),
        proc(1400, 1000, 'Task Proxy', { exe: '/opt/task-proxy/task-proxy', taskProxy: true, cpu: 0.8, memory: 310 * MB, started: now - 7000 }),
        proc(1410, 1400, 'pwsh', { command: 'pwsh -NoLogo -File PowerShell/RunTests.ps1', folder: storefront, project: 'Acme Storefront', taskProxy: true, cpu: 9.5, memory: 160 * MB, started: now - 40 }),
    ];
}

export function demoState(overrides = {}) {
    const navigation = [
        { name: 'Team Onboarding', icon: 'circle_user-plus|theme:primary|backing|inverted', url: `/${pages.onboarding}`, children: null },
        { name: 'Release Checklist', icon: 'circle_list-check|theme:success|backing|inverted', url: `/${pages.release}`, children: null },
        {
            name: 'Operations', icon: 'badge_server|backing|inverted|theme:info|bordered', url: null, children: [
                { name: 'Health Check', icon: 'heart-pulse', url: `/${pages.health}`, children: null },
                { name: 'Deploy', icon: 'rocket', url: `/${pages.deploy}`, children: null },
            ],
        },
    ];
    const environments = [
        { name: 'dev', variables: { apiBaseUrl: 'https://dev.api.acme.test', environment: 'dev', releaseType: 'patch' } },
        { name: 'staging', variables: { apiBaseUrl: 'https://staging.api.acme.test', environment: 'staging', releaseType: 'patch' } },
        { name: 'prod', variables: { apiBaseUrl: 'https://api.acme.test', environment: 'prod', releaseType: 'minor' } },
    ];
    const state = {
        project: PROJECT,
        projects: [PROJECT, { name: 'Acme Mobile', path: '/home/sam/code/acme-mobile' }, { name: 'Design System', path: '/home/sam/code/design-system' }],
        navigation,
        variables: ['apiBaseUrl|text|https://dev.api.acme.test', 'environment|text|dev', 'releaseType|text|patch'],
        data: {
            _environments: environments,
            _activeEnvironment: 'dev',
            apiBaseUrl: 'https://dev.api.acme.test',
            environment: 'dev',
            releaseType: 'patch',
        },
        appVariables: ['github_pat|secret|', 'deployToken|secret|'],
        appData: {
            github_pat: 'ghp_demoTokenValue1234567890',
            deployToken: 'demo-deploy-token-0000',
            'app-git-autosync': true,
        },
        docs: ['README.md', 'docs/architecture.md', 'docs/contributing.md'],
        scripts: ['.taskproxy/scripts/test.ps1', '.taskproxy/scripts/deploy.ps1', '.taskproxy/scripts/clean.ps1'],
        files: {
            [`.taskproxy/pages/${pages.onboarding}.md`]: onboardingPage,
            [`.taskproxy/pages/${pages.release}.md`]: releasePage,
            [`.taskproxy/pages/${pages.health}.md`]: healthPage,
            [`.taskproxy/pages/${pages.deploy}.md`]: deployPage,
            '.taskproxy/scripts/test.ps1': testScript,
            '.taskproxy/scripts/deploy.ps1': deployScript,
            '.taskproxy/scripts/clean.ps1': cleanScript,
            'README.md': readmeAfter,
            'docs/architecture.md': '# Architecture\n\nThe storefront is a Vite app that talks to the Acme API.\n\n- `src/` holds the app.\n- `tests/` holds the unit and browser tests.\n',
            'docs/contributing.md': '# Contributing\n\n1. Branch from `main`.\n2. Keep each pull request to one change.\n3. Add a test for every bug you fix.\n',
            'src/cart.js': cartAfter,
            'src/nav.json': navAfter,
            'tests/checkout.test.js': checkoutTest,
        },
        git: {
            repos: [''],
            changes: ['M  src/cart.js', 'M  README.md', '?? tests/checkout.test.js', 'M  src/nav.json'],
            lineStats: [
                lineStats('src/cart.js', cartDiff),
                lineStats('README.md', readmeDiff),
                { path: 'tests/checkout.test.js', additions: checkoutTest.split('\n').length, deletions: 0, binary: false },
                lineStats('src/nav.json', navDiff),
            ],
            diffs: { 'src/cart.js': cartDiff, 'README.md': readmeDiff, 'src/nav.json': navDiff },
            branches: [
                { name: 'main', isCurrent: false, updatedDate: '2026-11-05' },
                { name: 'feature/cart-discounts', isCurrent: true, updatedDate: '2026-11-07' },
                { name: 'bug/checkout-rounding', isCurrent: false, updatedDate: '2026-11-02' },
                { name: 'origin/main', isCurrent: false, updatedDate: '2026-11-05' },
                { name: 'origin/release/1.4', isCurrent: false, updatedDate: '2026-10-28' },
            ],
            currentBranch: 'feature/cart-discounts',
            status: { hasUpstream: true, upstreamName: 'origin/feature/cart-discounts', ahead: 2, behind: 1, remoteUrl: 'https://github.com/acme/storefront.git' },
        },
        processes: demoProcesses(),
        ...overrides,
    };
    return state;
}

/** What the test script prints, with the colors a terminal shows. */
export const testRunOutput = [
    '\x1b[36mRunning e2e tests\x1b[0m\r\n',
    { wait: 300 },
    '\r\n> acme-storefront@1.4.2 test:e2e\r\n> playwright test -g checkout\r\n\r\n',
    'Running 6 tests using 3 workers\r\n\r\n',
    { wait: 300 },
    '  \x1b[32m✓\x1b[0m  1 checkout.spec.ts:8:1 › the cart shows each item \x1b[2m(812ms)\x1b[0m\r\n',
    { wait: 250 },
    '  \x1b[32m✓\x1b[0m  2 checkout.spec.ts:16:1 › quantities count toward the total \x1b[2m(640ms)\x1b[0m\r\n',
    { wait: 250 },
    '  \x1b[32m✓\x1b[0m  3 checkout.spec.ts:25:1 › a discount lowers the total \x1b[2m(701ms)\x1b[0m\r\n',
    { wait: 250 },
    '  \x1b[32m✓\x1b[0m  4 checkout.spec.ts:33:1 › a discount never makes the total negative \x1b[2m(588ms)\x1b[0m\r\n',
    { wait: 250 },
    '  \x1b[32m✓\x1b[0m  5 checkout.spec.ts:41:1 › an empty cart cannot check out \x1b[2m(430ms)\x1b[0m\r\n',
    { wait: 250 },
    '  \x1b[32m✓\x1b[0m  6 checkout.spec.ts:50:1 › payment errors are shown \x1b[2m(955ms)\x1b[0m\r\n',
    { wait: 200 },
    '\r\n  \x1b[32m6 passed\x1b[0m \x1b[2m(4.1s)\x1b[0m\r\n',
];

/** The other saved projects, beside Acme Storefront, for the project list and its tiles. */
export const OTHER_PROJECTS = [
    { name: 'Acme Mobile', path: '/home/sam/code/acme-mobile' },
    { name: 'Design System', path: '/home/sam/code/design-system' },
    { name: 'Payments API', path: '/home/sam/code/payments-api' },
];

/** Square logos for the demo projects, as an image in each repo would be. */
const logo = (background, art) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${background}"/>${art}</svg>`;
export const PROJECT_LOGOS = {
    // A shopping cart.
    [PROJECT.path]: logo('#0f766e', '<path d="M12 16h6l6 24h22l5-17H21" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="27" cy="48" r="3.5" fill="#fbbf24"/><circle cx="43" cy="48" r="3.5" fill="#fbbf24"/>'),
    // A phone.
    '/home/sam/code/acme-mobile': logo('#7c3aed', '<rect x="21" y="10" width="22" height="44" rx="5" fill="none" stroke="#fff" stroke-width="4"/><circle cx="32" cy="46" r="2.5" fill="#fff"/><rect x="27" y="15" width="10" height="3" rx="1.5" fill="#c4b5fd"/>'),
    // Swatches.
    '/home/sam/code/design-system': logo('#e11d48', '<circle cx="24" cy="26" r="10" fill="#fde68a"/><circle cx="40" cy="26" r="10" fill="#93c5fd" fill-opacity=".9"/><circle cx="32" cy="40" r="10" fill="#fff" fill-opacity=".85"/>'),
    // A card.
    '/home/sam/code/payments-api': logo('#1d4ed8', '<rect x="10" y="18" width="44" height="28" rx="5" fill="none" stroke="#fff" stroke-width="4"/><rect x="10" y="25" width="44" height="5" fill="#fff"/><rect x="16" y="36" width="12" height="4" rx="2" fill="#fbbf24"/>'),
};

/** The images in Acme Storefront that could be its icon. */
export const STOREFRONT_IMAGES = {
    'assets/brand/storefront-logo.svg': PROJECT_LOGOS[PROJECT.path],
    'assets/brand/storefront-mono.svg': logo('#111827', '<path d="M12 16h6l6 24h22l5-17H21" fill="none" stroke="#e5e7eb" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="27" cy="48" r="3.5" fill="#e5e7eb"/><circle cx="43" cy="48" r="3.5" fill="#e5e7eb"/>'),
    'public/favicon.svg': logo('#f59e0b', '<text x="32" y="43" font-family="Arial, sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="#fff">A</text>'),
    'src/assets/empty-cart.svg': logo('#e5e7eb', '<path d="M12 16h6l6 24h22l5-17H21" fill="none" stroke="#6b7280" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>'),
};

/** AI providers as a team member might have them: Ollama on this computer for quick drafts, and Claude Code. */
export const AI_PROVIDERS = {
    providers: [
        { id: 'ollama', name: 'Ollama', kind: 'openAi', baseUrl: 'http://localhost:11434/v1', models: [{ id: 'qwen2.5-coder:7b', name: '' }, { id: 'llama3.2:3b', name: '' }], hidden: [] },
        {
            id: 'claude', name: 'Claude Code', kind: 'command',
            command: 'claude -p --setting-sources user --strict-mcp-config --permission-mode default --model {model} --tools "Read,Grep,Glob"',
            models: [{ id: 'sonnet', name: 'Claude Sonnet' }, { id: 'opus', name: 'Claude Opus' }], hidden: [],
        },
    ],
};

/** App data that turns every AI integration on, with Ollama for drafts and Claude for reviews. */
export const AI_APP_DATA = {
    'app-ai-integrations': { git: true, review: true, pages: true, scripts: true, markdown: true },
    'app-ai-models': { default: { provider: 'ollama', model: 'qwen2.5-coder:7b' }, review: { provider: 'claude', model: 'sonnet' } },
    'app-trusted-projects': [PROJECT.path],
};

/** What AI writes for each demo: the commit message, the review, a page part, and import suggestions. */
export const AI_REPLIES = {
    git: 'Apply discounts to the cart total\n\nFeature: The cart total takes an optional discount, and never goes below zero\nFeature: The nav links to the new Deals page\nBug: Item quantities were left out of the cart total\nTests: checkout.test.js covers quantities and discounts',
    review: `## Summary

The cart now counts quantities and takes a discount, and the new tests cover both. Two things to look at before merging.

## Findings

1. **src/cart.js**: \`item.quantity\` is used without a default, so an item saved before this change (with no quantity) makes the total \`NaN\`. Use \`item.quantity ?? 1\`.
2. **src/cart.js**: a negative \`discount\` raises the total. Clamp it with \`Math.max(0, discount)\`, or reject it.
3. **tests/checkout.test.js**: add a case for an item with no quantity, which would have caught the first finding.

## Looks good

- \`Math.max(0, total - discount)\` keeps the total from going below zero.
- The README now points new developers at the Team Onboarding page.`,
    pages: `Check these before tagging a release:

- All tests pass on \`main\`, and CI is green for the last push.
- The changelog lists every **Feature** and **Bug** since the last release.
- Product has signed off on the release notes.

Then tag and publish it:

1. Run **Bump the version** below, and commit the change as \`Release 1.5.0\`.
2. Push the tag with \`git push --tags\`, which deploys it to **staging**.
3. Check the storefront on staging, then run the **Deploy** page for \`prod\`.`,};

/** The markdown files an import of docs/ reads, and what AI suggests for them. */
export const IMPORT_DOCS = {
    'docs/architecture.md': '# Architecture\n\nThe storefront is a Vite app that talks to the Acme API.\n',
    'docs/contributing.md': '# Contributing\n\n1. Branch from `main`.\n2. Keep each pull request to one change.\n',
    'docs/runbooks/deploy.md': '# deploy\n\nDeploy with `./scripts/deploy.ps1 -Environment prod`.\n',
    'docs/runbooks/rollback.md': '# rollback\n\nRedeploy the last good tag.\n',
};
export const IMPORT_PLAN = [
    { file: 'docs/architecture.md', title: 'Architecture', subtitle: '', navPath: [], excerpt: 'The storefront is a Vite app that talks to the Acme API.' },
    { file: 'docs/contributing.md', title: 'Contributing', subtitle: '', navPath: [], excerpt: 'Branch from main. Keep each pull request to one change.' },
    { file: 'docs/runbooks/deploy.md', title: 'deploy', subtitle: '', navPath: ['runbooks'], excerpt: 'Deploy with ./scripts/deploy.ps1 -Environment prod.' },
    { file: 'docs/runbooks/rollback.md', title: 'rollback', subtitle: '', navPath: ['runbooks'], excerpt: 'Redeploy the last good tag.' },
];
export const IMPORT_SUGGESTED = JSON.stringify([
    { file: 'docs/architecture.md', title: 'Architecture', subtitle: 'How the storefront fits together', navPath: ['Guides'] },
    { file: 'docs/contributing.md', title: 'Contributing', subtitle: 'Branches, pull requests, and tests', navPath: ['Guides'] },
    { file: 'docs/runbooks/deploy.md', title: 'Deploy to Production', subtitle: 'Ship a tagged release', navPath: ['Runbooks'] },
    { file: 'docs/runbooks/rollback.md', title: 'Roll Back a Release', subtitle: 'Return to the last good tag', navPath: ['Runbooks'] },
]);
