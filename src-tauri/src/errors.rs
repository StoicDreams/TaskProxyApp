use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub(crate) enum TaskProxyError {
    NotImplemented(String),
    Invalid(String),
    MissingData,
    JsonParseError,
    JsonSerializeError,
    LockError(String),
    Error(String),
}

impl std::error::Error for TaskProxyError {}

impl std::fmt::Display for TaskProxyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TaskProxyError::NotImplemented(val) => write!(f, "Not Implemented: {}", val),
            TaskProxyError::Invalid(val) => write!(f, "Invalid: {}", val),
            TaskProxyError::MissingData => write!(f, "Missing Data"),
            TaskProxyError::JsonParseError => write!(f, "JSON Parse Error"),
            TaskProxyError::JsonSerializeError => write!(f, "JSON Serialization Error"),
            TaskProxyError::LockError(val) => write!(f, "Lock Error: {}", val),
            TaskProxyError::Error(val) => write!(f, "Error: {}", val),
        }
    }
}

impl From<std::fmt::Error> for TaskProxyError {
    fn from(value: std::fmt::Error) -> Self {
        TaskProxyError::Error(value.to_string())
    }
}

impl From<std::option::Option<std::convert::Infallible>> for TaskProxyError {
    fn from(value: std::option::Option<std::convert::Infallible>) -> Self {
        TaskProxyError::Error(format!("{:?}", value))
    }
}

impl From<serde_json::Error> for TaskProxyError {
    fn from(value: serde_json::Error) -> Self {
        match value.classify() {
            serde_json::error::Category::Io => TaskProxyError::Error(String::from("IO Error")),
            serde_json::error::Category::Syntax => TaskProxyError::JsonParseError,
            serde_json::error::Category::Data => TaskProxyError::JsonParseError,
            serde_json::error::Category::Eof => TaskProxyError::JsonParseError,
        }
    }
}
