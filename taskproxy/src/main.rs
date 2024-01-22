#![windows_subsystem = "windows"]
use crate::prelude::*;
use bevy::{
    core::TaskPoolThreadAssignmentPolicy,
    diagnostic::FrameTimeDiagnosticsPlugin,
    prelude::*,
    tasks::available_parallelism,
    window::{CursorGrabMode, PresentMode, WindowTheme},
};

mod data_types;
mod prelude;
mod startup;
mod update;

fn main() {
    App::new()
        .add_plugins(
            DefaultPlugins
                .set(TaskPoolPlugin {
                    task_pool_options: TaskPoolOptions {
                        min_total_threads: 1,
                        max_total_threads: std::usize::MAX, // unlimited threads
                        io: TaskPoolThreadAssignmentPolicy {
                            min_threads: 1,
                            max_threads: 2,
                            percent: 0.1,
                        },
                        async_compute: TaskPoolThreadAssignmentPolicy {
                            min_threads: 1,
                            max_threads: 2,
                            percent: 0.1,
                        },
                        compute: TaskPoolThreadAssignmentPolicy {
                            min_threads: available_parallelism() / 2,
                            max_threads: std::usize::MAX,
                            percent: 1.0,
                        },
                    },
                })
                .set(WindowPlugin {
                    primary_window: Some(Window {
                        title: "Task Proxy".into(),
                        resolution: (1400., 800.).into(),
                        present_mode: PresentMode::AutoNoVsync,
                        resize_constraints: WindowResizeConstraints {
                            min_width: 400.0,
                            min_height: 400.0,
                            max_width: 20000.0,
                            max_height: 20000.0,
                        },
                        fit_canvas_to_parent: true,
                        prevent_default_event_handling: false,
                        window_theme: Some(WindowTheme::Dark),
                        enabled_buttons: bevy::window::EnabledButtons {
                            ..Default::default()
                        },
                        visible: false,
                        ..default()
                    }),
                    ..default()
                }),
        )
        .add_plugins(FrameTimeDiagnosticsPlugin)
        .add_systems(
            Startup,
            (set_window_icon, setup_camera, setup_ui, setup_fps_counter),
        )
        .add_systems(
            Update,
            (
                render_main_content,
                fps_text_update_system,
                fps_counter_showhide,
                change_title,
                toggle_theme,
                toggle_cursor,
                toggle_vsync,
                cycle_cursor_icon,
                make_visible,
            ),
        )
        .run();
}

fn toggle_cursor(mut windows: Query<&mut Window>, input: Res<Input<KeyCode>>) {
    if input.just_pressed(KeyCode::Space) {
        let mut window = windows.single_mut();

        window.cursor.visible = !window.cursor.visible;
        window.cursor.grab_mode = match window.cursor.grab_mode {
            CursorGrabMode::None => CursorGrabMode::Locked,
            CursorGrabMode::Locked | CursorGrabMode::Confined => CursorGrabMode::None,
        };
    }
}

/// This system cycles the cursor's icon through a small set of icons when clicking
fn cycle_cursor_icon(
    mut windows: Query<&mut Window>,
    input: Res<Input<MouseButton>>,
    mut index: Local<usize>,
) {
    let mut window = windows.single_mut();

    const ICONS: &[CursorIcon] = &[
        CursorIcon::Default,
        CursorIcon::Hand,
        CursorIcon::Wait,
        CursorIcon::Text,
        CursorIcon::Copy,
    ];

    if input.just_pressed(MouseButton::Left) {
        *index = (*index + 1) % ICONS.len();
    } else if input.just_pressed(MouseButton::Right) {
        *index = if *index == 0 {
            ICONS.len() - 1
        } else {
            *index - 1
        };
    }

    window.cursor.icon = ICONS[*index];
}
