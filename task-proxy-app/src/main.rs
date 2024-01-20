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
    let components: Option<Vec<DynItem>> = build_components_from_markdown(
        r#"
# Task Proxy
Hello World

This is a super long line to test out what happens when it gets too long and stuff for what the heck is going on here is that a black cat oh no it is oh nooo oh noooooo!

This is a super long line to test out what happens when it gets too long and stuff for what the heck is going on here is that a black cat oh no it is oh nooo oh noooooo!

This is a super long line to test out what happens when it gets too long and stuff for what the heck is going on here is that a black cat oh no it is oh nooo oh noooooo!

This is a super long line to test out what happens when it gets too long and stuff for what the heck is going on here is that a black cat oh no it is oh nooo oh noooooo!

This is a super long line to test out what happens when it gets too long and stuff for what the heck is going on here is that a black cat oh no it is oh nooo oh noooooo!

This is a super long line to test out what happens when it gets too long and stuff for what the heck is going on here is that a black cat oh no it is oh nooo oh noooooo!

This is a super long line to test out what happens when it gets too long and stuff for what the heck is going on here is that a black cat oh no it is oh nooo oh noooooo!

This is a super long line to test out what happens when it gets too long and stuff for what the heck is going on here is that a black cat oh no it is oh nooo oh noooooo!

Extra line
"#,
    );
    if let Some(components) = components {
        let page_content = Rc::new(VecModel::<DynItem>::from(components));
        //ui.set_page_content(page_content.into());
        ui_handle.unwrap().set_page_content(page_content.into());
    }
    ui.run()
}
