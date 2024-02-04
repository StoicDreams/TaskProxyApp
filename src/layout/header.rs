use crate::prelude::*;

/// App header component
pub(crate) fn app_header(contexts: Contexts) -> Html {
    let Contexts {
        config,
        page_loaded,
        ..
    } = contexts.clone();
    let left_drawer_info = config.header_left_drawer_toggle.clone();
    let top_drawer_info = config.header_top_drawer_toggle.clone();
    let right_drawer_info = config.header_right_drawer_toggle.clone();
    let title_display = "<Project Dropdown>";
    html! {
        <header data-tauri-drag-region="true" class="titlebar">
            <AppDrawerButton info={left_drawer_info.clone()}
                class="logo"
                logosrc="/Logo.svg"
                logotitle={format!("{} Logo", config.company_name.to_owned())}
                />
            <h1 class="flex-grow" data-tauri-drag-region="true">
                { title_display }
            </h1>
            <AppDrawerButton info={top_drawer_info.clone()} />
            {config.header_strip_bar.unwrap_or(empty_html)(contexts.clone())}
            {config.user_info_panel.unwrap_or(empty_html)(contexts.clone())}
            <AppDrawerButton info={right_drawer_info.clone()} />
            {render_app_close()}
        </header>
    }
}

fn render_app_close() -> Html {
    html! {
        <>
            <div class="titlebar-button" id="titlebar-minimize" title="Minimize Window">
                <i class="far fa-window-minimize" />
            </div>
            <div class="titlebar-button" id="titlebar-maximize" title="Maximize Window" data-maximize="<i class=\"far fa-window-maximize\" />" data-restore="<i class=\"far fa-window-restore\" />">
                <i class="far fa-window-maximize" />
            </div>
            <div class="titlebar-button" id="titlebar-close" title="Close Application">
                <i class="far fa-xmark" />
            </div>
        </>
    }
}
