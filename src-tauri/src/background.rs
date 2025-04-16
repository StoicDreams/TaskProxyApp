use crate::prelude::*;
use std::time::Duration;
use tauri::AppHandle;
use tokio::time::sleep;

const DEFAULT_SAVE_INTERVAL_MINUTES: u64 = 5;

pub(crate) async fn background_tasks(app_handle: AppHandle) {
    println!("Background task started!");
    loop {
        // --- Determine sleep duration ---
        let mut interval_duration = Duration::from_secs(60 * DEFAULT_SAVE_INTERVAL_MINUTES);
        if let Ok(app_data) = get_app_data_from_app(&app_handle) {
            let current_interval_minutes = app_data.save_interval_minutes;
            if current_interval_minutes > 0 && current_interval_minutes <= 60 {
                interval_duration = Duration::from_secs(60 * current_interval_minutes);
            }
        }

        // --- Wait for the interval ---
        sleep(interval_duration).await;

        // --- Perform the save ---
        println!("Periodic save: Woke up, attempting to save...");
        if let Ok(app_data) = get_app_data_from_app(&app_handle) {
            match save_app_data_to_local_storage(&app_handle, &app_data) {
                Ok(msg) => println!("{}", msg),
                Err(err) => eprintln!("{}", err),
            }
        }
    }
}
