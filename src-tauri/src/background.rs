use crate::prelude::*;

const DEFAULT_SAVE_INTERVAL_MINUTES: u64 = 20;

pub(crate) async fn background_tasks(app_handle: AppHandle) {
    println!("Background task started!");
    loop {
        // --- Determine sleep duration ---
        let mut interval_duration = Duration::from_secs(60 * DEFAULT_SAVE_INTERVAL_MINUTES);
        if let Ok(app_data) = get_state_data::<TaskProxyData>(&app_handle) {
            let current_interval_minutes = app_data.save_interval_minutes;
            if current_interval_minutes > 0 && current_interval_minutes <= 60 {
                interval_duration = Duration::from_secs(60 * current_interval_minutes);
            }
        }

        // --- Wait for the interval ---
        sleep(interval_duration).await;

        // --- Perform the save ---
        println!("Periodic save: Attempting to save...");
        if let Ok(data) = get_state_data::<TaskProxyData>(&app_handle) {
            match save_app_data_to_local_storage(&app_handle, &data) {
                Ok(msg) => println!("{}", msg),
                Err(err) => eprintln!("{}", err),
            }
        }
        if let Ok(data) = get_state_data::<ProjectData>(&app_handle) {
            match save_project_data(data, &app_handle) {
                Ok(msg) => println!("{}", msg),
                Err(err) => eprintln!("{}", err),
            }
        }
    }
}
