use std::{env, path::PathBuf};

pub fn app_data_dir() -> PathBuf {
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local_app_data).join("TXT Reader");
    }

    env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("TXT Reader")
}

pub fn config_path() -> PathBuf {
    app_data_dir().join("config.toml")
}
