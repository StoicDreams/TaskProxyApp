# Task Proxy

<img src="https://www.taskproxy.com/ms-icon-310x310.png" alt="Stoic Dreams Task Proxy Logo" title="Stoic Dreams Task Proxy Logo" style="float:right;margin-top:-50px;height:60px;width:60px">

[Version: 0.1.95](https://github.com/StoicDreams/TaskProxyApp)

[![Task Proxy GitHub Actions][gh-image]][gh-checks]

[gh-image]: https://github.com/stoicdreams/taskproxyapp/actions/workflows/deploy.yml/badge.svg
[gh-checks]: https://github.com/stoicdreams/taskproxyapp/actions?query=branch%3Amain

**Supercharge Your Developer Workflow**

Task Proxy is a lightweight, cross-platform developer tool designed to manage documentation, scripts, and productivity features. It helps organize, simplify, and automate your workflows without adding friction. Built in [Rust](https://www.rust-lang.org/) and the [Tauri framework](https://tauri.app/) with [Web UI](https://webui.stoicdreams.com/), Task Proxy delivers native speed and reliability across Windows, Mac, and Linux.

## Why Choose Task Proxy?

- **Zero-Friction Collaboration:** Configurations and custom pages are stored within a `.taskproxy` folder in your project root. Everything stays perfectly synced and easily shared via your version control system.
- **Bulletproof Security:** Manage and store secrets for scripts and API connections securely. Task Proxy encrypts sensitive data via your OS's native credential manager, keeping it safely outside your repository.
- **Precision Context:** Scope variables to Global, Project, or Page levels, ensuring your data and secrets are only accessible exactly where they are needed.

## Core Capabilities

- **Project Management:** Create, add, and switch between multiple isolated workspaces instantly.
- **Git Controller:** Authenticate via Personal Access Tokens (PAT) to commit, sync, fetch, push, pull, branch, and stash directly from the UI, featuring a built-in diff viewer, and a script of your choice that runs before each commit.
- **Terminal & Script Manager:** Write parameterized PowerShell (`.ps1`) scripts with auto-generated UI inputs, and execute them in live background terminals or separate OS windows.
- **Docs & Nav Management:** Manage standard repository markdown files (e.g., `readme.md`) and create custom, modular Task Proxy pages using live data bindings and components.

## Example Workflows

- **Centralized Team Hubs:** Create modular Task Proxy Pages within your project to provide onboarding documentation, run health-check scripts, and show dynamic reports.
- **Automated Pipelines:** Utilize the integrated Script and Terminal Managers to queue and execute command flows in a specified sequence.
- **Live Documentation Editing:** Manage project documentation with side-by-side live rendering.

## Installation

Task Proxy is available for download on [TaskProxy.com](https://www.taskproxy.com/) for Windows, Mac, and Linux.

---

## Development Setup

If you want to build Task Proxy from source or contribute to the project, follow these steps.

### Notes

> All terminal commands examples are written as if starting from the root folder of this solution.

### Rust and Tauri

Install Rust and various related tooling needed and recommended for development.

```PowerShell
# Install rustup / rustc / cargo
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# Install compilers required by Tauri
sudo pacman -Syu --needed base-devel curl wget file openssl appmenu-gtk-module gtk3 libappindicator-gtk3 librsvg libvips webkit2gtk-4.1
# Install clippy linter and code formatter
rustup component add clippy rustfmt
# Install wasm target
rustup target add wasm32-unknown-unknown
# Recommended binary installer to use for dependencies
cargo install cargo-binstall
# Install Tauri tooling using binstall
cargo binstall cargo-cache trunk wasm-pack tauri-cli wasm-bindgen-cli -y
```

### Tools

Name | Description
--- | ---
Zed | Our choice of IDE for Rust / HTML / JavaScript development.
Visual Studio Code (VSC) | Common IDE for development.

### Solution Setup &amp; Configure

Visit the [Tauri Website](https://tauri.app/start/) for instructions on how to setup your local machine for developing Tauri applications.

```terminal
# Install trunk to serve web components for app
cargo intall trunk --lock

# Install tauri cli to run developer build
cargo install tauri-cli
```

### Updates

Commands to run to update tools and dependencies

Update trunk

```termanal
cargo install --locked trunk
```

### Build Project

```terminal
cargo tauri build
```

### Run Project

Use `cargo tauri dev` to build and run the Tauri app being developed.

```terminal
cargo tauri dev
```

### Testing

Backend tests are Rust tests. Run `trunk build` once first on a new checkout, because the tests embed `dist/`.

```terminal
cargo test -p taskproxy
```

UI tests use [Playwright](https://playwright.dev) and need no running app, since they serve the frontend straight from the repo and stand in for the backend. They do load the shared Web UI components from cdn.myfi.ws, so they need network access.

```terminal
npm install
npx playwright install chromium
```

On Linux the tests use `/usr/bin/chromium` if it exists, so the second command can be skipped. Set `PW_CHROMIUM_PATH` to use a different browser. Set `WEBUI_CDN_ROOT` to the `cdn` folder of a MyFiCDN checkout to test against Web UI changes before they are deployed.

| Command | Purpose |
|---|---|
| `npm test` | Run everything against the source files. Use this while working |
| `npm run test:ui` | Open the interactive runner, with watch mode and a timeline for each test |
| `npm run test:min` | Run everything against the `.min.js` files. Use this before pushing |
| `npm run test:report` | Open the last report, with a screenshot and trace for each failure |
| `npx playwright test tests/components/git-manager.spec.mjs` | Run one file |
| `npx playwright test -g "commit"` | Run tests by name |

## Tauri Docs

This project uses the Tauri Framework which enables us to use our web development expertise in HTML, CSS, and JavaScript to quickly and easily build our front-end, while using Rust as our backend for interactions with the System and performing any intensive processing in the low-level systems language that rust is.

Link | Details
--- | ---
[https://v2.tauri.app/start/](https://v2.tauri.app/start/) | Start page for Tauri V2 documentation
[https://tauri.app/develop/calling-rust/](https://tauri.app/develop/calling-rust/) | Learn more about Tauri commands.
[https://v2.tauri.app/plugin/](https://v2.tauri.app/plugin/) | Plugins that enable additional features.

---

## Author

**[Erik Gassler](https://www.erikgassler.com) - [Stoic Dreams](https://www.stoicdreams.com)** - Forging solutions for tomorrow's software development.

**Support** - Visit [Stoic Dreams' GitHub Sponsor page](https://github.com/sponsors/StoicDreams) if you would like to provide support to Stoic Dreams.

## License

[MIT](LICENSE)
