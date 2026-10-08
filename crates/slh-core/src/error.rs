use serde::ser::{Serialize, SerializeStruct, Serializer};
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;
pub type CommandResult<T> = Result<T, CommandError>;

#[derive(Debug, Error)]
pub enum AppError {
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
    #[error("An offline Minecraft name is required: {0}")]
    OfflineAccountNameRequired(String),
    #[error("This capability is unavailable: {0}")]
    Unavailable(String),
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
            Self::OfflineAccountNameRequired(_) => "offline_account_name_required",
            Self::Unavailable(_) => "unavailable",
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
}

impl From<AppError> for CommandError {
    fn from(value: AppError) -> Self {
        Self {
            code: value.code().to_owned(),
            message: crate::security::redact_secrets(&value.to_string()),
        }
    }
}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("CommandError", 2)?;
        state.serialize_field("code", &self.code)?;
        state.serialize_field("message", &self.message)?;
        state.end()
    }
}
