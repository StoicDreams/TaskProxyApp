# Task Proxy - Using Slint Framework

This was an early experiment at using the Slint UI framework for developing the Task Proxy desktop app with.

Development was halted on this version however after encountering some limitations within Slint that would not allow certain desired features of the application.

This crate will likely be deleted in a future commit.

## Dev

### Notes

> All terminal commands examples are written as if starting from the root folder of this solution.

### Solution Setup & Configure

```terminal
```

### Build Project

```terminal
cargo build
```

### Run Project

```terminal
cargo run
```

### Run Poject and Watch for Changes

First you will need to make sure you have `cargo-watch` installed.

```terminal
cargo install cargo-watch
```

Then you can run the project using the watcher so any code changes will update automatically.

```terminal
cargo watch -c -i *.md -i *.json -x run
```

### VSCode Setup

#### Slint Extension

Install the [Slint](https://slint.dev) to get access to its features that make developing with Slint easier.

**Features**:

- Syntax highlighting
- Diagnostics from .slint files
- Live Preview of a .slint file
- Completion of properties
- Jump to definition (currently, only definition of Component)

##### Slint Preview

To open the Slint Preview window
