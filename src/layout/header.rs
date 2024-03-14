use web_sys::EventTarget;

use crate::prelude::*;

/// App header component
pub(crate) fn app_header(contexts: &Contexts) -> Html {
    let Contexts {
        config,
        page_loaded,
        ..
    } = contexts.clone();
    let left_drawer_info = config.header_left_drawer_toggle.clone();
    let top_drawer_info = config.header_top_drawer_toggle.clone();
    let right_drawer_info = config.header_right_drawer_toggle.clone();
    html! {
        <header class="titlebar" data-tauri-drag-region="true">
            <AppDrawerButton info={left_drawer_info.clone()}
                class="logo"
                logosrc="/Logo.svg"
                logotitle={format!("{} Logo", config.company_name.to_owned())}
                />
            <RenderProjectDropdown />
            <div class="flex-grow"></div>
            <AppDrawerButton info={top_drawer_info.clone()} />
            {config.header_strip_bar.unwrap_or(empty_html)(contexts)}
            {config.user_info_panel.unwrap_or(empty_html)(contexts)}
            <AppDrawerButton info={right_drawer_info.clone()} />
            {render_app_close()}
        </header>
    }
}

#[function_component(RenderProjectDropdown)]
fn render_project_dropdown() -> Html {
    let mut project_list = vec![ProjectPath::new("New Project", "")];
    let context = use_context::<Contexts>().expect("Failed to find contexts");
    let current_project = context.get_app_data(DATA_KEY_CURRENT_PROJECT);
    let dropdown_project = use_state(String::default);
    let selected_project = dropdown_project.to_string();
    if current_project != selected_project {
        jslog!("Update selected project {}", selected_project);
        context.set_app_data(DATA_KEY_CURRENT_PROJECT, &selected_project);
    }
    let options = project_list
        .iter()
        .map(|project| {
            let display = project.name.clone();
            DropdownOption::new(&project.path, DynHtml::new(move || html! {display.clone()}))
        })
        .collect::<Vec<DropdownOption>>();
    html! {
        <div class="d-flex flex-row gap-1">
            <span>{"Project:"}</span>
            <Dropdown selected={dropdown_project} {options} />
        </div>
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
