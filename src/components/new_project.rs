use crate::prelude::*;
use std::fs::metadata;

pub(crate) fn new_project(_contexts: &Contexts) -> Html {
    html! {<NewProject /> }
}

#[function_component(NewProject)]
fn render_new_project() -> Html {
    let local_path = use_state(String::default);
    let local_path_text = local_path.to_string();
    let path_exists = metadata(&local_path_text).is_ok();
    let onsave = {
        let local_path_text = local_path_text.clone();
        Callback::from(|_| {})
    };

    html! {
        <>
            <InputText name="Local Path to Project" value={local_path.clone()} />
            {if path_exists {
                html!{
                    <Button onclick={onsave}>
                        {"Add Project Refernce"}
                    </Button>
                }
            } else {
                html!{format!("Path not found for {}", local_path_text)}
            }}
        </>
    }
}
