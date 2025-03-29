<webui-data data-page-title="Organize your development scripts, APIs, documentation, and more" data-page-subtitle=""></webui-data>

## Welcome to you Task Proxy Dashboard

This is your Task Proxy Dashboard. Not much to see here at the moment, as we're still very early in development.

## Current State of Development

<webui-page-segment>

- Integrated [Tauri](https://tauri.app) framework for simplified development and deployments to multiple platform targets (Windows, Mac, Linux).
- Integrated [Web UI Framework](https://webui.stoicdreams.com) for layout, components, and default styling.
- New Task Proxy desktop application is setup with CICD pipeline to build and publish app as changes are committed.

</webui-page-segment>

## Current Features being ported from Legacy App

<webui-page-segment>

- Create unique Task Proxy Projects for each project you need.
- Quickly and easily switch between projects within Task Proxy.
- Manage project README.md files with live display.
- Create and manage Task Proxy Pages within a project that can store multiple modules you setup to provide documentation, run scripts, show reports, and more.
- Manage and store secrets to use in scripts and API connections securely by encrypting them and storing them outside of any projects.
- Scope data to Global, Project, or Page to determine if it can be used across all projects, only within the current project, or only within the current page.
- Task Proxy pages are stored within the project folder [projectroot]/TaskProxyData so pages stay with the project and are easily synced and shared along with project updates - when using version control such as Git or Mercurial.
- Command flows that allow running specified scripts and apis in a specified sequence.

</webui-page-segment>

## Additional Planned Features for new App

<webui-page-segment>

- Terminal module that will allow running scripts that need to run continuously and not be restricted to only running when the hosting page is open.
- Schedule times and events to trigger running specfic scripts or command flows.

</webui-page-segment>

<webui-quote theme="info">

More information coming soon!

</webui-quote>
