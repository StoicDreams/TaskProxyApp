pub mod data_types;
pub mod prelude;

use prelude::*;

pub fn parse_markdown(_markdown: &str) -> Option<Vec<Token>> {
    if _markdown.is_empty() {
        return None;
    }
    let mut tokens = vec![];
    for line in _markdown.split('\n') {
        if line.is_empty() {
            tokens.push(Token::Empty);
            continue;
        }

        tokens.push(Token::Text(line.to_string()));
    }

    Some(tokens)
}
