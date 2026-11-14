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
2. Set your \`github_pat\` variable in **Manage Variables** so Task Proxy can push and pull.
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

The API address comes from the **apiBaseUrl** variable, so switching environments in **Manage Variables** changes what this script writes.

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
