use crate::prelude::*;
use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions, similarity::cosine_similarity};
use std::time::Instant;

/// How many results a search returns.
const MAX_RESULTS: usize = 30;
/// How long to wait after a failed model load before a search tries loading it again.
const RETRY_AFTER: Duration = Duration::from_secs(60);

/// An emoji that can be searched for.
pub(crate) struct EmojiEntry {
    /// The shortcode, such as `grinning_face`.
    pub key: String,
    /// The shortcode with spaces, shown to the user.
    pub name: String,
    /// The text that is matched against a search, lowercase.
    pub description: String,
}

#[derive(Default)]
pub(crate) struct EmojiState {
    pub is_initialized: bool,
    pub is_initializing: bool,
    pub model: Option<TextEmbedding>,
    /// Every supported emoji, available as soon as the list arrives, so searches work before the model loads.
    pub entries: Vec<EmojiEntry>,
    /// The embedding of each entry, in the same order, once the model has loaded.
    pub embeddings: Vec<Vec<f32>>,
    /// Why the model last failed to load.
    pub init_error: Option<String>,
    pub last_attempt: Option<Instant>,
}

pub(crate) type SharedEmojiState = Arc<Mutex<EmojiState>>;

/// Describe each supported emoji by its name and shortcode.
fn emoji_entries(supported_emojis: &[String]) -> Vec<EmojiEntry> {
    supported_emojis
        .iter()
        .map(|key| {
            let name = key.replace('_', " ");
            let description = match ::emojis::get_by_shortcode(key) {
                Some(e) => format!("{} {}", e.name(), e.shortcode().unwrap_or("")),
                None => name.clone(),
            };
            EmojiEntry {
                key: key.clone(),
                name,
                description: description.replace('_', " ").to_lowercase(),
            }
        })
        .collect()
}

/// Load the model and embed every description. This is slow, so it runs without holding the state lock.
fn build_emoji_index(
    descriptions: Vec<String>,
    cache_dir: PathBuf,
) -> Result<(TextEmbedding, Vec<Vec<f32>>), String> {
    println!(
        "Initializing embedding model with {} supported emojis...",
        descriptions.len()
    );
    let mut model = TextEmbedding::try_new(
        TextInitOptions::new(EmbeddingModel::AllMiniLML6V2)
            .with_cache_dir(cache_dir)
            .with_show_download_progress(true),
    )
    .map_err(|e| format!("Failed to initialize model: {}", e))?;
    let embeddings = model
        .embed(descriptions, None)
        .map_err(|e| format!("Failed to embed emojis: {}", e))?;
    Ok((model, embeddings))
}

/// Match a search against the emoji names when the model is not available.
/// Words that start a word in the name count more than words found inside one.
fn keyword_search(entries: &[EmojiEntry], query: &str) -> Vec<usize> {
    let query = query.to_lowercase();
    let terms: Vec<&str> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(usize, usize)> = entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let words: Vec<&str> = entry
                .description
                .split(|c: char| !c.is_alphanumeric())
                .filter(|word| !word.is_empty())
                .collect();
            let score: usize = terms
                .iter()
                .map(|term| {
                    if words.contains(term) {
                        3
                    } else if words.iter().any(|word| word.starts_with(term)) {
                        2
                    } else if entry.description.contains(term) {
                        1
                    } else {
                        0
                    }
                })
                .sum();
            (score > 0).then_some((index, score))
        })
        .collect();
    scored.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| entries[a.0].name.len().cmp(&entries[b.0].name.len()))
    });
    scored
        .into_iter()
        .take(MAX_RESULTS)
        .map(|(index, _)| index)
        .collect()
}

/// Find the emojis closest to a search, using the model when it has loaded and the names otherwise.
fn search(state: &mut EmojiState, query: &str) -> Result<Vec<usize>, String> {
    let EmojiState {
        model,
        entries,
        embeddings,
        ..
    } = state;
    let Some(model) = model.as_mut().filter(|_| embeddings.len() == entries.len()) else {
        return Ok(keyword_search(entries, query));
    };
    let query_embedding = model
        .embed(vec![query.to_string()], None)
        .map_err(|e| format!("Failed to embed query: {}", e))?
        .pop()
        .ok_or("Model returned no embedding.")?;
    let mut scored: Vec<(usize, f32)> = embeddings
        .iter()
        .enumerate()
        .map(|(index, emb)| (index, cosine_similarity(&query_embedding, emb)))
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    Ok(scored
        .into_iter()
        .take(MAX_RESULTS)
        .map(|(index, _)| index)
        .collect())
}

/// Load the model unless it is loaded or loading. Returns why it could not load.
async fn load_model(app_handle: AppHandle, shared_state: SharedEmojiState) -> Result<(), String> {
    let descriptions = {
        let mut emoji_state = shared_state
            .lock()
            .map_err(|_| "Failed to lock emoji state")?;
        if emoji_state.is_initialized || emoji_state.is_initializing {
            return Ok(());
        }
        emoji_state.is_initializing = true;
        emoji_state.last_attempt = Some(Instant::now());
        emoji_state
            .entries
            .iter()
            .map(|entry| entry.description.clone())
            .collect::<Vec<_>>()
    };
    let cache_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())
        .map(|dir| dir.join("fastembed"));
    let built = match cache_dir {
        Ok(cache_dir) => task::spawn_blocking(move || build_emoji_index(descriptions, cache_dir))
            .await
            .map_err(|e| format!("Failed to initialize model: {}", e))
            .and_then(|result| result),
        Err(err) => Err(err),
    };
    let mut emoji_state = shared_state
        .lock()
        .map_err(|_| "Failed to lock emoji state")?;
    emoji_state.is_initializing = false;
    match built {
        Ok((model, embeddings)) => {
            emoji_state.model = Some(model);
            emoji_state.embeddings = embeddings;
            emoji_state.is_initialized = true;
            emoji_state.init_error = None;
            println!("Emoji embeddings initialized successfully!");
            Ok(())
        }
        Err(err) => {
            eprintln!("Emoji search is matching names only. {}", err);
            emoji_state.init_error = Some(err.clone());
            Err(err)
        }
    }
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
        emoji_state.entries = emoji_entries(&supported_emojis);
    }
    load_model(app_handle, shared_state)
        .await
        .map_err(|err| format!("Emoji search will match names only. {}", err))?;
    Ok("Initialized".to_string())
}

#[tauri::command]
pub(crate) async fn search_emojis(
    app_handle: AppHandle,
    query: String,
    state: State<'_, SharedEmojiState>,
) -> Result<Vec<serde_json::Value>, String> {
    let state_clone = state.inner().clone();
    let (results, retry) = task::spawn_blocking(move || -> Result<_, String> {
        let mut emoji_state = state_clone
            .lock()
            .map_err(|_| "Failed to lock emoji state")?;
        let indexes = search(&mut emoji_state, &query)?;
        let results: Vec<serde_json::Value> = indexes
            .into_iter()
            .map(|index| {
                let entry = &emoji_state.entries[index];
                serde_json::json!({ "emoji": entry.key, "name": entry.name })
            })
            .collect();
        // A model that failed to load, from a download cut short for example, is tried again now and then.
        let retry = !emoji_state.is_initialized
            && !emoji_state.is_initializing
            && !emoji_state.entries.is_empty()
            && emoji_state
                .last_attempt
                .is_none_or(|at| at.elapsed() >= RETRY_AFTER);
        Ok((results, retry))
    })
    .await
    .map_err(|e| e.to_string())??;
    if retry {
        let shared_state = state.inner().clone();
        tauri::async_runtime::spawn(async move {
            let _ = load_model(app_handle, shared_state).await;
        });
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(keys: &[&str]) -> Vec<EmojiEntry> {
        emoji_entries(&keys.iter().map(|key| key.to_string()).collect::<Vec<_>>())
    }

    fn found(entries: &[EmojiEntry], query: &str) -> Vec<String> {
        keyword_search(entries, query)
            .into_iter()
            .map(|index| entries[index].key.clone())
            .collect()
    }

    #[test]
    fn keyword_search_matches_names_without_the_model() {
        let list = entries(&["grinning", "heart", "broken_heart", "red_car", "smile"]);
        assert_eq!(found(&list, "heart"), vec!["heart", "broken_heart"]);
        assert_eq!(found(&list, "Broken Heart"), vec!["broken_heart", "heart"]);
        assert_eq!(found(&list, "car"), vec!["red_car"]);
    }

    #[test]
    fn keyword_search_prefers_whole_words_then_word_starts() {
        let list = entries(&["scarf", "carpentry_saw", "car"]);
        assert_eq!(found(&list, "car"), vec!["car", "carpentry_saw", "scarf"]);
    }

    #[test]
    fn keyword_search_with_nothing_to_match_finds_nothing() {
        let list = entries(&["heart", "smile"]);
        assert!(found(&list, "  ").is_empty());
        assert!(found(&list, "zebra").is_empty());
        assert!(found(&[], "heart").is_empty());
    }

    #[test]
    fn search_without_a_model_falls_back_to_names() {
        let mut state = EmojiState {
            entries: entries(&["heart", "smile"]),
            init_error: Some("Failed to initialize model: no network".to_string()),
            ..Default::default()
        };
        let indexes = search(&mut state, "smile").expect("search works without the model");
        assert_eq!(indexes, vec![1]);
    }

    #[test]
    fn keyword_search_returns_at_most_the_result_limit() {
        let keys: Vec<String> = (0..50).map(|i| format!("heart_{i}")).collect();
        let list = emoji_entries(&keys);
        assert_eq!(keyword_search(&list, "heart").len(), MAX_RESULTS);
    }
}
