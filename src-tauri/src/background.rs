use crate::prelude::*;

const DEFAULT_SAVE_INTERVAL_MINUTES: u64 = 20;

pub(crate) async fn background_tasks(app_handle: AppHandle) {
    println!("Background task started!");

    let mut last_app_data_json = String::new();
    let mut last_project_data_json = String::new();

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
        println!("Periodic save: Checking for data changes...");

        if let Ok(data) = get_state_data::<TaskProxyData>(&app_handle) {
            if let Ok(current_json) = crate::common::to_json(&data) {
                if current_json != last_app_data_json {
                    println!("App data changed. Attempting to save...");
                    match save_app_data_to_local_storage(&app_handle, &data).await {
                        Ok(msg) => {
                            println!("{}", msg);
                            last_app_data_json = current_json;
                        },
                        Err(err) => eprintln!("{}", err),
                    }
                }
            }
        }

        if let Ok(data) = get_state_data::<ProjectData>(&app_handle) {
            if let Ok(current_json) = crate::common::to_json(&data) {
                if current_json != last_project_data_json {
                    println!("Project data changed. Attempting to save...");
                    match save_project_data(data.clone(), app_handle.clone()).await {
                        Ok(msg) => {
                            println!("{}", msg);
                            last_project_data_json = current_json;
                        },
                        Err(err) => eprintln!("{}", err),
                    }
                }
            }
        }
    }
}
