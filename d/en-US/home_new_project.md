# Create a new Project Reference

```section
<NewProject />
```

## What are project references for?

```section
In Task Proxy, you use project references to manage data associated with your projects.

A project can be any folder on your machine, but typically you should set project references to the same root folder as your code repository (i.e. Git, Mercurial, SVN, etc.) root.

When a project reference is created, a `.taskproxy` folder will be added to the folder specified as the project root. This folder will hold all project data created within Task Proxy, except for user specified variable values which are considered `secrets` and are stored securily elsewhere on your machine.
```

> NOTE: If you are adding a new project reference to a folder that already has a `.taskproxy` folder then that project data will be loaded.

> NOTE: Variables can be set with default values, which are stored within the `.taskproxy` data. Use default values to set default data that might be common across multiple machines or developers but can be overwritten on a per-machine basis. Data considered `secret` should never be set as a default value.

## Organize your development scripts, APIs, documentation, and more

> NOTE: You are accessing a very early build of this application.

```section
Welcome to Task Proxy! Your development tool for managing your documentation and scripts alongside productivity features to help organize, simplify, and automate your workflows.

The primary concept for Task Proxy is to provide users with a tool where they can easily create and manage project documentation, scripts, and configurations.
```

## Latest Features / Progress

```section

- Builds for Windows, Mac, and Linux.

```

## Features currently being ported from our Legacy App

````section

- Account Login
- Create unique Task Proxy Projects for each project you need.
- Quickly and easily switch between projects within Task Proxy.
- Manage project README.md files with live display.
- Create and manage Task Proxy Pages within a project that can store multiple modules you setup to provide documentation, run scripts, show reports, and more.
- Manage and store secrets to use in scripts and API connections securely by encrypting them and storing them outside of any projects.
- Scope data to Global, Project, or Page to determine if it can be used across all projects, only within the current project, or only within the current page.
- Task Proxy pages are stored within the project folder [projectroot]/.taskproxy so pages stay with the project and are easily synced and shared along with project updates - when using version control such as Git or Mercurial.
- Command flows that allow running specified scripts and apis in a specified sequence.

````

## Planned Features

````section

- Terminal module that will allow running scripts that need to run continuously and not be restricted to only running when the hosting page is open.
- Schedule times and events to trigger running specfic scripts or command flows.

````
