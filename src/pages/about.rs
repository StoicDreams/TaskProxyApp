use crate::prelude::*;

/// Page for app/company information.
pub fn page_about(contexts: Contexts) -> Html {
    set_title("About");
    let tags = get_markdown_tags();
    let app_config = contexts.clone().config;
    html! {
        <>
            {title_primary!("About")}
            <Paper class="ma-2 mb-0 clear">
                <Paper class="float-left mr-2">
                    <img src="icon.webp" title="Task Proxy Logo" width="64px" />
                </Paper>
                <Paper class="d-flex flex-grow flex-column justify-center gap-0 h-fill">
                    <strong>
                        {format!("{} {}", app_config.company_name, app_config.app_name)}
                    </strong>
                    <p>{"Version 0.1.0"}</p>
                </Paper>
            </Paper>
            <MarkdownContent href="/d/en-US/about.md" {tags} />
            <Paper class={CLASSES_FLEX_READABLE_CENTERED}>
                {stoic_header_strip_bar(contexts)}
            </Paper>
            <NextPageButton url="/home" />
        </>
    }
}
