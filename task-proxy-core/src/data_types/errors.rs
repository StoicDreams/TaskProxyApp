#[derive(Debug)]
pub enum StoicDreamsError {
    Invalid(String),
    MissingData,
    LockError(String),
    Error(String),
}

impl std::error::Error for StoicDreamsError {}

impl std::fmt::Display for StoicDreamsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoicDreamsError::Invalid(val) => write!(f, "Invalid: {}", val),
            StoicDreamsError::MissingData => write!(f, "Missing Data"),
            StoicDreamsError::LockError(val) => write!(f, "Lock Error: {}", val),
            StoicDreamsError::Error(val) => write!(f, "Error: {}", val),
        }
    }
}

impl From<std::fmt::Error> for StoicDreamsError {
    fn from(value: std::fmt::Error) -> Self {
        StoicDreamsError::Error(value.to_string())
    }
}

impl From<std::option::Option<std::convert::Infallible>> for StoicDreamsError {
    fn from(value: std::option::Option<std::convert::Infallible>) -> Self {
        StoicDreamsError::Error(format!("{:?}", value))
    }
}
