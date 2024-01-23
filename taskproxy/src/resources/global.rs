use bevy::window::WindowTheme;

use crate::prelude::*;

pub enum QuadPosition {
    Top,
    Right,
    Bottom,
    Left,
}

pub enum OctPosition {
    Top,
    TopRight,
    Right,
    BottomRight,
    Bottom,
    BottomLeft,
    Left,
    TopLeft,
}

#[derive(Resource)]
pub struct MenuLayout(pub QuadPosition);

#[derive(Resource)]
pub struct CurrentTheme(pub WindowTheme);

#[derive(Resource, Default)]
pub struct Colors {
    pub primary: Color,
    pub primary_offset: Color,
    pub secondary: Color,
    pub secondary_offset: Color,
    pub tertiary: Color,
    pub tertiary_offset: Color,
    pub success: Color,
    pub success_offset: Color,
    pub info: Color,
    pub info_offset: Color,
    pub warning: Color,
    pub warning_offset: Color,
    pub error: Color,
    pub error_offset: Color,
    pub dark: Color,
    pub dark_offset: Color,
    pub light: Color,
    pub light_offset: Color,
    pub background: Color,
    pub background_offset: Color,
}
