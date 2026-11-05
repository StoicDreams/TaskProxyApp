use crate::prelude::*;
use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions, similarity::cosine_similarity};

pub(crate) struct EmojiState {
    pub is_initialized: bool,
    pub is_initializing: bool,
    pub model: Option<TextEmbedding>,
    pub emoji_data: Vec<(String, String, Vec<f32>)>,
}

impl Default for EmojiState {
    fn default() -> Self {
        Self {
            is_initialized: false,
            is_initializing: false,
            model: None,
            emoji_data: Vec::new(),
        }
    }
}

pub(crate) type SharedEmojiState = Arc<Mutex<EmojiState>>;

/// Build the model and embeddings. This is slow, so it runs without holding the state lock.
fn build_emoji_index(
    supported_emojis: Vec<String>,
    cache_dir: PathBuf,
) -> Result<(TextEmbedding, Vec<(String, String, Vec<f32>)>), String> {
    println!(
        "Initializing embedding model with {} supported emojis...",
        supported_emojis.len()
    );
    let mut model = TextEmbedding::try_new(
        TextInitOptions::new(EmbeddingModel::AllMiniLML6V2)
            .with_cache_dir(cache_dir)
            .with_show_download_progress(true),
    )
    .map_err(|e| format!("Failed to initialize model: {}", e))?;
    let mut descriptions = Vec::new();
    let mut cached_emojis = Vec::new();
    for key in supported_emojis {
        let mut desc = key.replace("_", " ");
        if let Some(e) = ::emojis::get_by_shortcode(&key) {
            desc = format!("{} {}", e.name(), e.shortcode().unwrap_or(""));
        }
        descriptions.push(desc);
        let name = key.replace("_", " ");
        cached_emojis.push((key, name));
    }
    let embeddings = model
        .embed(descriptions, None)
        .map_err(|e| format!("Failed to embed emojis: {}", e))?;
    let emoji_data = cached_emojis
        .into_iter()
        .zip(embeddings)
        .map(|((key, name), emb)| (key, name, emb))
        .collect();
    Ok((model, emoji_data))
}

#[tauri::command]
pub(crate) async fn init_emoji_search(
    app_handle: AppHandle,
    supported_emojis: Vec<String>,
    state: State<'_, SharedEmojiState>,
) -> Result<String, String> {
    let shared_state = state.inner().clone();
    {
        let mut emoji_state = shared_state
            .lock()
            .map_err(|_| "Failed to lock emoji state")?;
        if emoji_state.is_initialized || emoji_state.is_initializing {
            return Ok("Already initialized".to_string());
        }
        emoji_state.is_initializing = true;
    }
    let cache_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())
        .map(|dir| dir.join("fastembed"));
    let built = match cache_dir {
        Ok(cache_dir) => {
            task::spawn_blocking(move || build_emoji_index(supported_emojis, cache_dir))
                .await
                .map_err(|e| e.to_string())
                .and_then(|result| result)
        }
        Err(err) => Err(err),
    };
    let mut emoji_state = shared_state
        .lock()
        .map_err(|_| "Failed to lock emoji state")?;
    emoji_state.is_initializing = false;
    let (model, emoji_data) = built?;
    emoji_state.model = Some(model);
    emoji_state.emoji_data = emoji_data;
    emoji_state.is_initialized = true;
    println!("Emoji embeddings initialized successfully!");
    Ok("Initialized".to_string())
}

#[tauri::command]
pub(crate) async fn search_emojis(
    query: String,
    state: State<'_, SharedEmojiState>,
) -> Result<Vec<serde_json::Value>, String> {
    let state_clone = state.inner().clone();
    let result = task::spawn_blocking(move || -> Result<Vec<serde_json::Value>, String> {
        let mut emoji_state = state_clone
            .lock()
            .map_err(|_| "Failed to lock emoji state")?;
        if !emoji_state.is_initialized {
            return Err("Model not initialized. Please wait for data to load.".to_string());
        }
        let model = emoji_state.model.as_mut().ok_or("Model not initialized.")?;
        let query_embedding = model
            .embed(vec![query], None)
            .map_err(|e| format!("Failed to embed query: {}", e))?
            .pop()
            .ok_or("Model returned no embedding.")?;
        let mut scored_emojis: Vec<(&String, &String, f32)> = emoji_state
            .emoji_data
            .iter()
            .map(|(emoji_key, name, emb)| {
                let score = cosine_similarity(&query_embedding, emb);
                (emoji_key, name, score)
            })
            .collect();
        scored_emojis.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
        let top_results = scored_emojis
            .into_iter()
            .take(30)
            .map(|(emoji_key, name, _score)| {
                serde_json::json!({
                    "emoji": emoji_key,
                    "name": name
                })
            })
            .collect();
        Ok(top_results)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(result)
}
