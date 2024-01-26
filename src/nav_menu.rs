use crate::prelude::*;

pub fn nav_menu_info() -> DrawerToggleInfo {
    DrawerToggleInfo::builder(
        |_| String::from("Navigation Menu"),
        |_| html! {<i class="fa-solid fa-bars"></i>},
        DynContextsHtml::new(nav_menu_render),
    )
    .set_button_class("btn toggle theme-inherit")
    .hide_header()
    .hide_footer()
    .set_drawer(Direction::Left)
    .build()
}

pub(crate) fn get_nav_routing() -> Vec<NavRoute> {
    let nav_routes = vec![
        NavLinkInfo::link("Home", "/", "fa-duotone fa-house", roles::PUBLIC, page_home),
        NavLinkInfo::link(
            "About",
            "/about",
            "fa-duotone fa-circle-info",
            roles::PUBLIC,
            page_about_stoic_dreams,
        ),
        NavLinkInfo::link(
            "Terms",
            "/terms",
            "fa-duotone fa-handshake",
            roles::PUBLIC,
            page_terms,
        ),
        NavLinkInfo::link(
            "Privacy",
            "/privacy",
            "fa-duotone fa-shield-exclamation",
            roles::PUBLIC,
            page_privacy,
        ),
    ];
    nav_routes.to_owned()
}

fn nav_menu_render(_contexts: Contexts) -> Html {
    html! {
        <>
            <Paper class="d-flex pa-1 justify-center">
                <img src="icon.png" title="Task Proxy Logo" />
            </Paper>
            <NavDisplay routes={get_nav_routing()} class="d-flex flex-column pa-1" />
        </>
    }
}
