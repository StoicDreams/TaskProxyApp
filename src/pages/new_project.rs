use crate::prelude::*;

/// App home page
pub(crate) fn page_new_project(_contexts: &Contexts) -> Html {
    set_title("Create New Project");
    html! {
        <>
            <Paper class={classes!(CLASSES_SIDE_BY_SIDE, "gap-2").to_string()}>
                <p>{"Use this page to add a new project to Task Proxy which will make it available in the Project dropdown above."}</p>
                {markdown!(r#"
                Use this page to add a new project to Task Proxy which will then be available in the Project dropdown above.
                "#)}
            </Paper>
            <NextPageButton url="/about" />
        </>
    }
}
