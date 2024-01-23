use crate::prelude::*;
use bevy::prelude::*;
use bevy::window::WindowTheme;
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

/// Marker component for displaying the main page content.
#[derive(Component)]
pub(crate) struct MainContent;

/// Marker component for displaying the main menu bar
#[derive(Component)]
pub(crate) struct MainMenuContent;

pub(crate) fn setup_settings(
    mut commands: Commands,
    mut colors: ResMut<Colors>,
    theme: Res<CurrentTheme>,
) {
    colors.primary = Color::hex("DD00DD").unwrap();
    colors.primary_offset = Color::hex("FFFFFF").unwrap();
    colors.secondary = Color::hex("00DD00").unwrap();
    colors.secondary_offset = Color::hex("FFFFFF").unwrap();
    colors.tertiary = Color::hex("DDDD00").unwrap();
    colors.tertiary_offset = Color::hex("FFFFFF").unwrap();
    colors.success = Color::hex("00CC00").unwrap();
    colors.success_offset = Color::hex("FFFFFF").unwrap();
    colors.info = Color::hex("0088DD").unwrap();
    colors.info_offset = Color::hex("FFFFFF").unwrap();
    colors.warning = Color::hex("DD8800").unwrap();
    colors.warning_offset = Color::hex("FFFFFF").unwrap();
    colors.error = Color::hex("DD0000").unwrap();
    colors.error_offset = Color::hex("FFFFFF").unwrap();
    colors.dark = Color::hex("333333").unwrap();
    colors.dark_offset = Color::hex("FFFFFF").unwrap();
    colors.light = Color::hex("DDDDCC").unwrap();
    colors.light_offset = Color::hex("333333").unwrap();
    colors.background = match theme.0 {
        WindowTheme::Dark => colors.dark,
        WindowTheme::Light => colors.light,
    };
    colors.background_offset = match theme.0 {
        WindowTheme::Dark => colors.dark_offset,
        WindowTheme::Light => colors.light_offset,
    };
}

// Spawns the UI
pub(crate) fn setup_ui(mut cmd: Commands, colors: Res<Colors>) {
    // Node that fills entire background
    cmd.spawn(NodeBundle {
        style: Style {
            width: Val::Percent(100.),
            height: Val::Percent(100.),
            ..default()
        },
        background_color: BackgroundColor(colors.background),
        ..default()
    })
    .with_children(|root| {
        root.spawn((
            NodeBundle {
                style: Style {
                    width: Val::Percent(100.),
                    min_height: Val::Px(18.),
                    ..default()
                },
                background_color: BackgroundColor(colors.primary),
                ..default()
            },
            MainMenuContent,
        ));
        root.spawn((
            NodeBundle {
                style: Style {
                    width: Val::Percent(100.),
                    height: Val::Auto,
                    ..default()
                },
                background_color: BackgroundColor(colors.secondary),
                ..default()
            },
            MainContent,
        ))
        .with_children(|parent| {
            // Text where we display current resolution
            parent.spawn(TextBundle::from_section(
                "",
                TextStyle {
                    font_size: 16.0,
                    color: colors.secondary_offset,
                    ..default()
                },
            ));
        });
    });
}
