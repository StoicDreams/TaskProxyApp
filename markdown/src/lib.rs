pub mod data_types;
pub mod prelude;

use prelude::*;

pub fn parse_markdown(_markdown: &str) -> Result<(), MarkdownError> {
    Err(MarkdownError::Error("Not yet implemented".to_string()))
}
