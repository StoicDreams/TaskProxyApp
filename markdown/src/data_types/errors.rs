#[derive(Debug)]
pub enum MarkdownError {
    Invalid(String),
    MissingData,
    LockError(String),
    Error(String),
}

impl std::error::Error for MarkdownError {}

impl std::fmt::Display for MarkdownError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MarkdownError::Invalid(val) => write!(f, "Invalid: {}", val),
            MarkdownError::MissingData => write!(f, "Missing Data"),
            MarkdownError::LockError(val) => write!(f, "Lock Error: {}", val),
            MarkdownError::Error(val) => write!(f, "Error: {}", val),
        }
    }
}

impl From<std::fmt::Error> for MarkdownError {
    fn from(value: std::fmt::Error) -> Self {
        MarkdownError::Error(value.to_string())
    }
}

impl From<std::option::Option<std::convert::Infallible>> for MarkdownError {
    fn from(value: std::option::Option<std::convert::Infallible>) -> Self {
        MarkdownError::Error(format!("{:?}", value))
    }
}
