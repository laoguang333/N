use std::{fs, path::Path};

use anyhow::Context;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Config {
    pub listen: String,
    pub database_path: String,
    pub library_dirs: Vec<String>,
    pub scan_recursive: bool,
    pub scan_on_startup: bool,
    pub cors_allowed_origins: Option<Vec<String>>,
    pub tls_cert_path: Option<String>,
    pub tls_key_path: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: "0.0.0.0:3000".to_string(),
            database_path: "data/reader.sqlite".to_string(),
            library_dirs: vec!["novels".to_string()],
            scan_recursive: false,
            scan_on_startup: false,
            cors_allowed_origins: None,
            tls_cert_path: None,
            tls_key_path: None,
        }
    }
}

impl Config {
    pub fn load(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let path = path.as_ref();
        if !path.exists() {
            return Ok(Self::default());
        }

        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read config file {}", path.display()))?;
        let config = toml::from_str(&raw)
            .with_context(|| format!("failed to parse config file {}", path.display()))?;
        Ok(config)
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

        assert_eq!(config.listen, "0.0.0.0:3000");
        assert_eq!(config.database_path, "data/reader.sqlite");
        assert_eq!(config.library_dirs, vec!["novels"]);
        assert!(!config.scan_recursive);
        assert!(!config.scan_on_startup);
        assert!(config.cors_allowed_origins.is_none());
        assert!(config.tls_cert_path.is_none());
        assert!(config.tls_key_path.is_none());
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
        assert_eq!(config.database_path, "data/reader.sqlite");
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
