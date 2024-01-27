use crate::prelude::*;

/// Page for app/company information.
pub fn page_about(_contexts: Contexts) -> Html {
    set_title(format!("About {}", get_app_name()).as_str());
    let tags = get_markdown_tags();
    html! {
        <>
            <MarkdownContent href="/d/en-US/about.md" {tags} />
            <NextPageButton url="/home" />
        </>
    }
}
