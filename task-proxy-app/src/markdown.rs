use crate::prelude::*;
use markdown_parser::prelude::*;

impl DynItem {
    fn empty() -> Self {
        DynItem {
            dtype: DynType::Empty,
            value_text: "".into(),
        }
    }
    fn text(text: &str) -> Self {
        DynItem {
            dtype: DynType::Text,
            value_text: text.into(),
        }
    }
}

pub fn build_components_from_markdown(markdown: &str) -> Option<Vec<DynItem>> {
    if let Some(tokens) = parse_markdown(markdown) {
        let mut components = vec![];
        for token in tokens {
            components.push(match token {
                Token::Empty => DynItem::empty(),
                Token::Text(text) => DynItem::text(&text),
            });
        }
        return Some(components);
    }
    None
}
