use bevy::prelude::*;
use bevy::winit::WinitWindows;
use winit::window::Icon;

const ICON: &[u8] = include_bytes!("../../assets/img/Logo-32.png");

pub(crate) fn set_window_icon(
    // we have to use `NonSend` here
    windows: NonSend<WinitWindows>,
) {
    if let Ok(image) = image::load_from_memory(ICON) {
        // here we use the `image` crate to load our icon data from a png file
        // this is not a very bevy-native solution, but it will do
        let (icon_rgba, icon_width, icon_height) = {
            let image = image.as_rgba8().unwrap();
            let (width, height) = image.dimensions();
            let rgba = image.clone().into_raw();
            (rgba, width, height)
        };
        let icon = Icon::from_rgba(icon_rgba, icon_width, icon_height).unwrap();

        // do it for all windows
        for window in windows.windows.values() {
            window.set_window_icon(Some(icon.clone()));
        }
    }
}

// Spawns the camera that draws UI
pub(crate) fn setup_camera(mut cmd: Commands) {
    cmd.spawn(Camera2dBundle::default());
}

/// Marker component for the text that displays the current resolution.
#[derive(Component)]
pub(crate) struct MainContentText;

// Spawns the UI
pub(crate) fn setup_ui(mut cmd: Commands) {
    // Node that fills entire background
    cmd.spawn(NodeBundle {
        style: Style {
            width: Val::Percent(100.),
            height: Val::Percent(100.),
            ..default()
        },
        ..default()
    })
    .with_children(|root| {
        // Text where we display current resolution
        root.spawn((
            TextBundle::from_section(
                "",
                TextStyle {
                    font_size: 16.0,
                    ..default()
                },
            ),
            MainContentText,
        ));
    });
}
