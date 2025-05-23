# Task Proxy

<img
 src="https://www.taskproxy.com/ms-icon-310x310.png"
 alt="Stoic Dreams Task Proxy Logo"
 title="Stoic Dreams Task Proxy Logo"
 style="float:right;margin-top:-60px"
 />

[Version: 0.1.24](https://github.com/StoicDreams/TaskProxyApp)

[![Task Proxy GitHub Actions][gh-image]][gh-checks]

[gh-image]: https://github.com/stoicdreams/taskproxyapp/actions/workflows/deploy.yml/badge.svg
[gh-checks]: https://github.com/stoicdreams/taskproxyapp/actions?query=branch%3Amain

Task Proxy is a desktop application targeted towards software developers and power users to help them document and organize their workflows, automation scripts, and project documentation and configurations.

A key feature of Task Proxy is the ability to allow teams and developers to create and share reports, scripts, automation, and onboarding workflows to help new team members get setup quickly, and help assure developers stays in sync as project configurations are changed.

<div style="clear:both"></div>

## Expected launch features include

- Reporting components generated from script results or API endpoint results.
- Scoped variables for storing common, dev-specific, or secret data values.
- Script templating allowing variables editable in UI
- Event driven triggers to run specified scripts on specified events (file updates, button in UI, git commit, etc).
- Support for Windows 10/11, Mac, Linux

## Expected Use-Cases

- Onboarding workflow with step-by-step guidance for developers to setup their local environment for deploying projects locally (websites, fabric cluster, etc).
- Managing / Sharing scripts (Powershell, command prompt, SQL).
- Sharing team & project documentation (Architecture, features, coding standards, etc) organized using a tag-based system inspired by mind-map applications.
- Health report that will verify required SDKs/configurations are installed/setup as expected for Team/project.

## Planned Cloud Services

- Option to store variable data in cloud.

## Planned Website Services

- Paste exported project, page, and unit templates to share.
- View templates shared by others.
- Vote on templates.

## Expected Workflows

### Opening Task Proxy for the first time

When opening the application for the first time, the user should be presented with a startup guide giving them a quick overview of the application and the ability to create their first project. Any Project specific menu items should be disabled / hidden.

### Cloud Services

Planned workflow to enable Cloud Services:

1. Create an account at StoicDreams.com and sign-up for desired subscription service option.
1. Sign-in to Task Proxy app with your Stoic Dreams account credentials.
1. App will automatically detect service availability and enable Cloud settings in App settings.
1. In Cloud Settings, user can toggle cloud features to enable or disable.

### Manage Variables

Variables are data objects that can be used to fill in values. It is recommended to use variables for any dynamic values used for any scripts or processes. But you absolutely need to use variables where any secrets might be used to assure secrets are not getting saved in any shared files or scripts.

#### Variable Scopes

Variables can be scoped as Page, Project, and Global scopes. Page scoped variables are only available to the page they are defined in. And project scoped variables are available anywhere within the project. While Global scopes can be accessed across any project.

When scripts or components are accessing variable values with keys duplicated across scopes, they will only use the value that is from the highest priority available. Page scoped variables have the highest priority, then Project, then Global.

### Create a new Report

Reports are components that can use an API endpoint or script to generate report data that can then be displayed in the page.

## Software Expectations / Goals

- Task Proxy uses the naming convention of `Project` to represent a collection of configurations, documentation, scripts, and solutions.
- Task Proxy can track multiple projects to be loaded and saved as desired.
- Only 1 project can be loaded at a time.
- Users will have the option of storing projects locally when using the standard (free) version of Task Proxy.
  - The common expected use case is to setup the root of a repository as a Task Proxy project. This way all associated project data is always synced with its respective repository and anyone who clones the repository will have access to the associated Task Proxy project.
- Users will have the option of storing projects in the Cloud with a paid subscription. Cloud projects will store variables in the cloud.
- Projects, pages, and components can be exported and imported into other projects.
- Encryption keys are never passed to or stored in the Cloud. Project data stored in the cloud is encrypted prior to transfer and are never decrypted in the Cloud.

## Changes from Legacy

The original Task Proxy application was written using C#/.NET Blazor Maui. The current version is being rebuilt from the ground up to be built in [Rust](https://www.rust-lang.org/) using the [Tauri framework](https://v2.tauri.app/), with [Web UI](https://webui.stoicdreams.com). Aside from the language changes there are a number of other key differences planned for how the application will function.

Feature | Legacy - C# | Current - Rust | Reason for Change
--- | --- | --- | ---
Local Storage Folder | ./TaskProxyData | ./.taskproxy | More appropriate to match commonly used industry standard naming convention for folders that store app specific data associated with a project/solution.
Local Storage Files | Encrypted data | md / json | Project pages, scripts, and other shared assets will be stored in text formats such as markdown, json, and script file formats.

## Installation

Task Proxy is currently in very early development but is available for download on [TaskProxy.com](https://www.taskproxy.com) for Windows, Mac, and Linux.

## Dev

### Notes

> All terminal commands examples are written as if starting from the root folder of this solution.

### Tools

Name | Description
--- | ---
Visual Studio Code (VSC) | Our choice of IDE for Rust / HTML / JavaScript development.
Better Minify | VSC extension used to minify .css and .js files.

### Solution Setup & Configure

Visit the [Tauri Website](https://tauri.app/start/) for instructions on how to setup your local machine for developing Tauri applications.

```terminal
# Install trunk to serve web components for app
cargo intall trunk

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

## Tauri Docs

This project uses the Tauri Framework which enables us to use our web development expertise in HTML, CSS, and JavaScript to quickly and easily build our front-end, while using Rust as our backend for interactions with the System and performing any intensive processing in the low-level systems language that rust is.

Link | Details
--- | ---
[https://v2.tauri.app/start/](https://v2.tauri.app/start/) | Start page for Tauri V2 documentation
[https://tauri.app/develop/calling-rust/](https://tauri.app/develop/calling-rust/) | Learn more about Tauri commands.
[https://v2.tauri.app/plugin/](https://v2.tauri.app/plugin/) | Plugins that enable additional features.
