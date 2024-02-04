#![allow(unused)] // TODO: Remove me when needing to check for dead code / unused methods/variables.
mod layout;
mod nav_menu;
mod pages;
mod prelude;

use prelude::*;

pub const VERSION: &str = "0.1.0";

fn main() {
    webui::start_app(setup_app_config());
}

fn setup_app_config() -> AppConfig {
    set_myfi_app_key("https://www.taskproxy.com");
    AppConfig::builder(
        "Task Proxy".to_string(),
        "Stoic Dreams".to_string(),
        "https://www.stoicdreams.com".to_owned(),
        "TaskProxy.com".to_owned(),
    )
    .set_header(layout::header::app_header)
    .set_no_footer()
    .set_header_logo_src("Logo.png".to_owned())
    .set_nav_routing(nav_menu::get_nav_routing())
    .set_drawer_toggle_header_left(nav_menu::nav_menu_info())
    .set_drawer_toggle_header_middle(myfi_feedback_button_info())
    //.set_header_strip_bar(stoic_header_strip_bar)
    .set_user_info_panel(myfi_info_panel)
    .set_copyright_start(2016)
    .external_links_open_new_tab_only()
    .build()
}
