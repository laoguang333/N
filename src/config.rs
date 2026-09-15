use std::{fs, path::Path, path::PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};

use crate::app_paths::{app_data_dir, config_path};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Config {
    pub listen: String,
    pub database_path: String,
    pub library_dirs: Vec<String>,
    pub scan_recursive: bool,
    pub scan_on_startup: bool,
    pub anime_dirs: Vec<String>,
    pub anime_scan_recursive: bool,
    pub anime_scan_on_startup: bool,
    pub anime_transcode_cache_dir: String,
    pub cors_allowed_origins: Option<Vec<String>>,
    pub tls_cert_path: Option<String>,
    pub tls_key_path: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        let app_data = app_data_dir();
        Self {
            listen: "0.0.0.0:234".to_string(),
            database_path: app_data.join("reader.sqlite").to_string_lossy().to_string(),
            library_dirs: vec![app_data.join("novels").to_string_lossy().to_string()],
            scan_recursive: false,
            scan_on_startup: false,
            anime_dirs: vec![r"D:\will\[A]".to_string()],
            anime_scan_recursive: true,
            anime_scan_on_startup: false,
            anime_transcode_cache_dir: app_data.join("anime-hls").to_string_lossy().to_string(),
            cors_allowed_origins: None,
            tls_cert_path: Some(
                app_data
                    .join("server-cert.pem")
                    .to_string_lossy()
                    .to_string(),
            ),
            tls_key_path: Some(
                app_data
                    .join("server-key.pem")
                    .to_string_lossy()
                    .to_string(),
            ),
        }
    }
}

impl Config {
    pub fn load(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let path = path.as_ref();
        if !path.exists() {
            let config = Self::default();
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .with_context(|| format!("failed to create config dir {}", parent.display()))?;
            }
            let raw =
                toml::to_string_pretty(&config).context("failed to serialize default config")?;
            fs::write(path, raw)
                .with_context(|| format!("failed to write config file {}", path.display()))?;
            return Ok(config);
        }

        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read config file {}", path.display()))?;
        let config = toml::from_str(&raw)
            .with_context(|| format!("failed to parse config file {}", path.display()))?;
        Ok(config)
    }

    pub fn config_path() -> PathBuf {
        config_path()
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    #[test]
    fn load_missing_config_uses_defaults() {
        let path = temp_file("missing-config.toml");
        let config = Config::load(&path).unwrap();

        assert_eq!(config.listen, "0.0.0.0:234");
        assert!(config.database_path.ends_with(r"TXT Reader\reader.sqlite"));
        assert!(
            config
                .library_dirs
                .iter()
                .all(|path| path.contains(r"TXT Reader\novels"))
        );
        assert!(!config.scan_recursive);
        assert!(!config.scan_on_startup);
        assert!(config.cors_allowed_origins.is_none());
        assert!(
            config
                .tls_cert_path
                .as_deref()
                .is_some_and(|path| path.ends_with(r"TXT Reader\server-cert.pem"))
        );
        assert!(
            config
                .tls_key_path
                .as_deref()
                .is_some_and(|path| path.ends_with(r"TXT Reader\server-key.pem"))
        );
    }

    #[test]
    fn load_partial_config_preserves_new_defaults() {
        let path = temp_file("partial-config.toml");
        fs::write(
            &path,
            r#"
listen = "127.0.0.1:4000"
library_dirs = ["books"]
"#,
        )
        .unwrap();

        let config = Config::load(&path).unwrap();

        assert_eq!(config.listen, "127.0.0.1:4000");
        assert!(config.database_path.ends_with(r"TXT Reader\reader.sqlite"));
        assert_eq!(config.library_dirs, vec!["books"]);
        assert!(!config.scan_recursive);
        assert!(!config.scan_on_startup);

        let _ = fs::remove_file(path);
    }

    fn temp_file(name: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "txt-reader-test-{}-{stamp}-{name}",
            std::process::id()
        ))
    }
}
