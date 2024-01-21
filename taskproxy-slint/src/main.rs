#![windows_subsystem = "windows"]
pub mod data_types;
pub mod markdown;
pub mod prelude;
use crate::prelude::*;
use markdown::build_components_from_markdown;
use slint::VecModel;
use std::rc::Rc;

fn main() -> Result<(), slint::PlatformError> {
    let ui = AppWindow::new()?;
    let ui_handle = ui.as_weak();
    let components: Option<Vec<MarkdownItem>> = build_components_from_markdown(markdown::WELCOME);
    if let Some(components) = components {
        let page_content = Rc::new(VecModel::<MarkdownItem>::from(components));
        ui_handle.unwrap().set_page_content(page_content.into());
    }
    ui.run()
}
