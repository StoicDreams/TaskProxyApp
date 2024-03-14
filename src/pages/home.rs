use crate::prelude::*;

/// App home page
pub(crate) fn page_home(_contexts: &Contexts) -> Html {
    set_title("Task Proxy Welcome");
    html! {
        <>
            <MarkdownContent href="/d/en-US/home.md" />
            <NextPageButton url="/about" />
        </>
    }
}
