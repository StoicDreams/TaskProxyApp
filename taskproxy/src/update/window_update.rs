use crate::prelude::*;
use bevy::{
    core::FrameCount,
    window::{PresentMode, WindowTheme},
};

/// This system is the top level handler for rendering page content to the app window.
pub(crate) fn render_main_content(
    mut commands: Commands,
    //mut q: Query<&mut NodeBundle, With<MainContent>>,
) {
    //let mut node = q.single_mut();
    //node.sections[0].value = "Hello world".to_string();
}

/// This system is used to make the window visible after the app has finished loading.
/// The purpose of this process is to eliminate a blank white window flashing during app startup.
// Alternatively, we could toggle the visibility in Startup.
// It will work, but it will have one white frame before it starts rendering
pub(crate) fn make_visible(mut window: Query<&mut Window>, frames: Res<FrameCount>) {
    // The delay may be different for each app or system.
    if frames.0 == 3 {
        // At this point the gpu is ready to show the app so we can make the window visible.
        window.for_each_mut(|mut win| {
            win.visible = true;
        });
    }
}

/// This system watches for CTRL+V to toggle the vsync mode.
pub(crate) fn toggle_vsync(input: Res<Input<KeyCode>>, mut windows: Query<&mut Window>) {
    if (input.pressed(KeyCode::ControlLeft) || input.pressed(KeyCode::ControlRight))
        && input.just_pressed(KeyCode::V)
    {
        let mut window = windows.single_mut();
        window.present_mode = if matches!(window.present_mode, PresentMode::AutoVsync) {
            PresentMode::AutoNoVsync
        } else {
            PresentMode::AutoVsync
        };
        info!("PRESENT_MODE: {:?}", window.present_mode);
    }
}

/// This system will change the title during execution
/// We could move this to startup if we want to change to a static title.
pub(crate) fn change_title(mut windows: Query<&mut Window>, time: Res<Time>) {
    let mut window = windows.single_mut();
    window.title = format!(
        "Task Proxy - {}:{}:{}",
        time_segment_display(time.elapsed_seconds_f64() / 360.0),
        time_segment_display(time.elapsed_seconds_f64() / 60.0),
        time_segment_display(time.elapsed_seconds_f64() % 60.0)
    );
}

/// Translate a numeric number that represents a time segment (i.e. hour, minute, second) into a double digit string.
/// e.g. "01", "12", "37", "09"
fn time_segment_display(segment: f64) -> String {
    let value = segment as u64;
    if value > 9 {
        return value.to_string();
    }
    format!("0{}", value)
}

// This system watches for CTRL+T to toggle the color theme used by the window.
pub(crate) fn toggle_theme(
    mut windows: Query<&mut Window>,
    input: Res<Input<KeyCode>>,
    mut theme: ResMut<CurrentTheme>,
    mut colors: ResMut<Colors>,
) {
    if (input.pressed(KeyCode::ControlLeft) || input.pressed(KeyCode::ControlRight))
        && input.just_pressed(KeyCode::T)
    {
        let mut window = windows.single_mut();
        theme.0 = match theme.0 {
            WindowTheme::Light => WindowTheme::Dark,
            WindowTheme::Dark => WindowTheme::Light,
        };
        colors.background = match theme.0 {
            WindowTheme::Dark => colors.dark,
            WindowTheme::Light => colors.light,
        };
        colors.background_offset = match theme.0 {
            WindowTheme::Dark => colors.dark_offset,
            WindowTheme::Light => colors.light_offset,
        };
        window.window_theme = Some(theme.0);
    }
}
