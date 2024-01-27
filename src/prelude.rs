pub(crate) use crate::layout::*;
pub(crate) use crate::pages::*;
pub(crate) use webui::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = ["window", "__TAURI__", "tauri"])]
    async fn invoke(cmd: &str, args: JsValue) -> JsValue;
}
