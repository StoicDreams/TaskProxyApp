use crate::prelude::*;
use fastembed::{TextEmbedding, TextInitOptions, EmbeddingModel, similarity::cosine_similarity};

pub(crate) struct EmojiState {
    pub is_initialized: bool,
    pub model: Option<TextEmbedding>,
    pub emoji_data: Vec<(String, String, Vec<f32>)>,
}

impl Default for EmojiState {
    fn default() -> Self {
        Self {
            is_initialized: false,
            model: None,
            emoji_data: Vec::new(),
        }
    }
}

pub(crate) type SharedEmojiState = Arc<Mutex<EmojiState>>;

#[tauri::command]
pub(crate) async fn init_emoji_search(
    supported_emojis: Vec<String>,
    state: State<'_, SharedEmojiState>,
) -> Result<String, String> {
    let state_clone = state.inner().clone();

    let result = task::spawn_blocking(move || -> Result<String, String> {
        let mut emoji_state = state_clone.lock().map_err(|_| "Failed to lock emoji state")?;

        if emoji_state.is_initialized {
            return Ok("Already initialized".to_string());
        }

        println!("Initializing embedding model with {} supported emojis...", supported_emojis.len());

        let mut model = TextEmbedding::try_new(
            TextInitOptions::new(EmbeddingModel::AllMiniLML6V2)
                .with_show_download_progress(true)
        ).map_err(|e| format!("Failed to initialize model: {}", e))?;

        let mut descriptions = Vec::new();
        let mut cached_emojis = Vec::new();

        for key in supported_emojis {
            // Build rich descriptions using the key (and falling back to crate data if available)
            let mut desc = key.replace("_", " ");

            // Borrow the rich descriptors from the crate to make semantic search smarter
            if let Some(e) = ::emojis::get_by_shortcode(&key) {
                desc = format!("{} {}", e.name(), e.shortcode().unwrap_or(""));
            }

            descriptions.push(desc);
            // Save the exact key your UI uses so we can return it flawlessly
            cached_emojis.push((key.clone(), key.replace("_", " ")));
        }

        let embeddings = model.embed(descriptions, None).map_err(|e| format!("Failed to embed emojis: {}", e))?;

        emoji_state.emoji_data = cached_emojis.into_iter()
            .zip(embeddings.into_iter())
            .map(|((key, name), emb)| (key, name, emb))
            .collect();

        emoji_state.model = Some(model);
        emoji_state.is_initialized = true;
        println!("Emoji embeddings initialized successfully!");

        Ok("Initialized".to_string())
    }).await.map_err(|e| e.to_string())??;

    Ok(result)
}

#[tauri::command]
pub(crate) async fn search_emojis(
    query: String,
    state: State<'_, SharedEmojiState>,
) -> Result<Vec<serde_json::Value>, String> {

    let state_clone = state.inner().clone();

    let result = task::spawn_blocking(move || -> Result<Vec<serde_json::Value>, String> {
        let mut emoji_state = state_clone.lock().map_err(|_| "Failed to lock emoji state")?;

        if !emoji_state.is_initialized {
            return Err("Model not initialized. Please wait for data to load.".to_string());
        }

        let model = emoji_state.model.as_mut().unwrap();

        let query_embedding = model.embed(vec![query], None)
            .map_err(|e| format!("Failed to embed query: {}", e))?
            .pop()
            .unwrap();

        let mut scored_emojis: Vec<(&String, &String, f32)> = emoji_state.emoji_data.iter().map(|(emoji_key, name, emb)| {
            let score = cosine_similarity(&query_embedding, emb);
            (emoji_key, name, score)
        }).collect();

        scored_emojis.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

        let top_results = scored_emojis.into_iter().take(30).map(|(emoji_key, name, _score)| {
            serde_json::json!({
                "emoji": emoji_key,
                "name": name
            })
        }).collect();

        Ok(top_results)
    }).await.map_err(|e| e.to_string())??;

    Ok(result)
}