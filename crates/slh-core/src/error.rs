use serde::ser::{Serialize, SerializeStruct, Serializer};
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;
pub type CommandResult<T> = Result<T, CommandError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Installation cancelled")]
    Cancelled,
    #[error("File operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Database operation failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Database migration failed: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("Window operation failed: {0}")]
    Window(String),
    #[error("Network request failed: {0}")]
    Network(#[from] reqwest::Error),
    #[error("Invalid JSON data: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Archive operation failed: {0}")]
    Archive(#[from] zip::result::ZipError),
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    #[error("Requested item was not found: {0}")]
    NotFound(String),
    #[error("The operation conflicts with current state: {0}")]
    Conflict(String),
    #[error("Java {required} or newer is required, but {path} is Java {actual}")]
    JavaCompatibility { required: u32, actual: u32, path: String },
    #[error("An offline Minecraft name is required: {0}")]
    OfflineAccountNameRequired(String),
    #[error("This capability is unavailable: {0}")]
    Unavailable(String),
    #[error("Manual CurseForge downloads required in {directory}")]
    ManualDownloads { directory: String, files: Vec<ManualDownloadFile> },
    #[error("Process failed: {0}")]
    Process(String),
    #[error("Security check failed: {0}")]
    Security(String),
    #[error("Two-factor authentication is required: {0}")]
    TwoFactorRequired(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Io(_) => "io_error",
            Self::Database(_) => "database_error",
            Self::Migration(_) => "database_migration_error",
            Self::Window(_) => "window_error",
            Self::Network(_) => "network_error",
            Self::Json(_) => "invalid_json",
            Self::Archive(_) => "archive_error",
            Self::InvalidInput(_) => "invalid_input",
            Self::NotFound(_) => "not_found",
            Self::Conflict(_) => "conflict",
            Self::JavaCompatibility { .. } => "conflict",
            Self::OfflineAccountNameRequired(_) => "offline_account_name_required",
            Self::Unavailable(_) => "unavailable",
            Self::ManualDownloads { .. } => "manual_downloads_required",
            Self::Process(_) => "process_error",
            Self::Security(_) => "security_error",
            Self::TwoFactorRequired(_) => "two_factor_required",
        }
    }
}

#[derive(Debug)]
pub struct CommandError {
    pub code: String,
    pub message: String,
    pub message_key: Option<String>,
    pub params: Option<serde_json::Value>,
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualDownloadFile { pub name: String, pub file_name: String, pub url: String }

impl From<AppError> for CommandError {
    fn from(value: AppError) -> Self {
        let (message_key, params, details) = match &value {
            AppError::Unavailable(message) if message.starts_with("Bedrock Preview downloads are disabled.") => (Some("errors.bedrockPreviewStoreOnly".into()), None, None),
            AppError::ManualDownloads { directory, files } => (Some("installation.manualRequired".into()), None, Some(serde_json::json!({ "directory": directory, "files": files }))),
            AppError::JavaCompatibility { required, actual, path } => (Some("errors.javaCompatibility".into()), Some(serde_json::json!({"required":required,"actual":actual})), Some(serde_json::json!({"path":path}))),
            AppError::Unavailable(message) if message == "Choose a Java executable or enable automatic Java detection" => (Some("errors.javaManualRequired".into()), None, None),
            AppError::Unavailable(message) if message == "No compatible Java runtime was found; select or install Java in Settings" => (Some("errors.javaDownloadDisabled".into()), None, None),
            _ => (Some(format!("errors.{}", value.code())), None, None),
        };
        Self {
            code: value.code().to_owned(),
            message: crate::security::redact_secrets(&value.to_string()),
            message_key, params, details,
        }
    }
}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("CommandError", 5)?;
        state.serialize_field("code", &self.code)?;
        state.serialize_field("message", &self.message)?;
        if let Some(value) = &self.message_key { state.serialize_field("messageKey", value)?; }
        if let Some(value) = &self.params { state.serialize_field("params", value)?; }
        if let Some(value) = &self.details { state.serialize_field("details", value)?; }
        state.end()
    }
}
