use crate::prelude::*;

const DEFAULT_SAVE_INTERVAL_MINUTES: u64 = 20;

/// How long to wait between autosaves: the chosen number of minutes from 1 to 60, or the default otherwise.
fn save_interval(chosen_minutes: Option<u64>) -> Duration {
    let minutes = chosen_minutes
        .filter(|minutes| (1..=60).contains(minutes))
        .unwrap_or(DEFAULT_SAVE_INTERVAL_MINUTES);
    Duration::from_secs(60 * minutes)
}

pub(crate) async fn background_tasks(app_handle: AppHandle) {
    println!("Background task started!");

    let mut last_app_data_json = String::new();
    let mut last_project_data_json = String::new();

    loop {
        // --- Determine sleep duration ---
        let interval_duration = save_interval(
            get_state_data::<TaskProxyData>(&app_handle)
                .ok()
                .map(|app_data| app_data.save_interval_minutes),
        );

        // --- Wait for the interval ---
        sleep(interval_duration).await;

        // --- Perform the save ---
        println!("Periodic save: Checking for data changes...");

        if let Ok(data) = get_state_data::<TaskProxyData>(&app_handle) {
            if let Ok(current_json) = crate::common::to_json(&data) {
                if current_json != last_app_data_json {
                    println!("App data changed. Attempting to save...");
                    match save_app_data_to_local_storage(&app_handle, &data).await {
                        Ok(msg) => {
                            println!("{}", msg);
                            last_app_data_json = current_json;
                        }
                        Err(err) => eprintln!("{}", err),
                    }
                }
            }
        }

        if let Ok(data) = get_state_data::<ProjectData>(&app_handle) {
            if data.id.is_empty() {
                continue;
            }
            if let Ok(current_json) = crate::common::to_json(&data) {
                if current_json != last_project_data_json {
                    println!("Project data changed. Attempting to save...");
                    match persist_project_data(data, &app_handle).await {
                        Ok(msg) => {
                            println!("{}", msg);
                            last_project_data_json = current_json;
                        }
                        Err(err) => eprintln!("{}", err),
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chosen_save_interval_is_used_from_1_to_60_minutes() {
        assert_eq!(save_interval(Some(1)), Duration::from_secs(60));
        assert_eq!(save_interval(Some(60)), Duration::from_secs(3600));
    }

    #[test]
    fn a_missing_or_out_of_range_save_interval_uses_the_default() {
        let default = Duration::from_secs(60 * DEFAULT_SAVE_INTERVAL_MINUTES);
        assert_eq!(save_interval(None), default);
        assert_eq!(save_interval(Some(0)), default);
        assert_eq!(save_interval(Some(61)), default);
    }
}
