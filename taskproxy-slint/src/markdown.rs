use crate::prelude::*;
use markdown::mdast::*;

pub const WELCOME: &str = include_str!("../md/welcome.md");

impl MarkdownItem {
    fn empty() -> Self {
        MarkdownItem {
            mdtype: MarkdownType::Empty,
            value: "".into(),
        }
    }
    fn text(text: &str) -> Self {
        MarkdownItem {
            mdtype: MarkdownType::Text,
            value: text.into(),
        }
    }
}

pub fn build_components_from_markdown(markdown: &str) -> Option<Vec<MarkdownItem>> {
    let mut components = vec![];
    match markdown::to_mdast(markdown, &markdown::ParseOptions::gfm()) {
        Ok(node) => {
            transpose_node_to_markdownitem(&mut components, node);
            Some(components)
        }
        Err(err) => {
            println!("{}", err);
            None
        }
    }
}

fn transpose_node_to_markdownitem(components: &mut Vec<MarkdownItem>, node: Node) {
    match node {
        Node::Root(root) => handle_root(components, root),
        Node::BlockQuote(blockquote) => handle_blockquote(components, blockquote),
        Node::FootnoteDefinition(footnote_definition) => {
            handle_footnote_definition(components, footnote_definition)
        }
        Node::MdxJsxFlowElement(mdx_jsx_flow_element) => {
            handle_mdx_jsx_flow_element(components, mdx_jsx_flow_element)
        }
        Node::List(list) => handle_list(components, list),
        Node::MdxjsEsm(mdx_js_esm) => handle_mdx_js_esm(components, mdx_js_esm),
        Node::Toml(toml) => handle_toml(components, toml),
        Node::Yaml(yaml) => handle_yaml(components, yaml),
        Node::Break(line_break) => handle_line_break(components, line_break),
        Node::InlineCode(inline_code) => handle_inline_code(components, inline_code),
        Node::InlineMath(inline_math) => handle_inline_math(components, inline_math),
        Node::Delete(delete) => handle_delete(components, delete),
        Node::Emphasis(emphasis) => handle_emphasis(components, emphasis),
        Node::MdxTextExpression(mdx_text_expressions) => {
            handle_mdx_text_expressions(components, mdx_text_expressions)
        }
        Node::FootnoteReference(footnote_reference) => {
            handle_footnote_reference(components, footnote_reference)
        }
        Node::Html(html) => handle_html(components, html),
        Node::Image(image) => handle_image(components, image),
        Node::ImageReference(image_reference) => {
            handle_image_reference(components, image_reference)
        }
        Node::MdxJsxTextElement(mdx_jsx_text_element) => {
            handle_mdx_jsx_text_element(components, mdx_jsx_text_element)
        }
        Node::Link(link) => handle_link(components, link),
        Node::LinkReference(link_reference) => handle_link_reference(components, link_reference),
        Node::Strong(strong) => handle_strong(components, strong),
        Node::Text(text) => handle_text(components, text),
        Node::Code(code) => handle_code(components, code),
        Node::Math(math) => handle_math(components, math),
        Node::MdxFlowExpression(mdx_flow_expr) => handle_mdx_flow_expr(components, mdx_flow_expr),
        Node::Heading(heading) => handle_heading(components, heading),
        Node::Table(table) => handle_table(components, table),
        Node::ThematicBreak(thematic_break) => handle_thematic_break(components, thematic_break),
        Node::TableRow(table_row) => handle_table_row(components, table_row),
        Node::TableCell(table_cell) => handle_table_cell(components, table_cell),
        Node::ListItem(list_item) => handle_list_item(components, list_item),
        Node::Definition(definition) => handle_definition(components, definition),
        Node::Paragraph(paragraph) => handle_paragraph(components, paragraph),
    };
}

fn handle_root(components: &mut Vec<MarkdownItem>, root: Root) {
    for node in root.children {
        transpose_node_to_markdownitem(components, node);
    }
}

fn handle_blockquote(components: &mut Vec<MarkdownItem>, blockquote: BlockQuote) {
    components.push(MarkdownItem::text(&format!(
        "BlockQuote {:?}",
        blockquote.children.len()
    )));
}

fn handle_footnote_definition(
    components: &mut Vec<MarkdownItem>,
    footnote_definition: FootnoteDefinition,
) {
    components.push(MarkdownItem::text(&format!(
        "FootnoteDefinition {:?}",
        footnote_definition.children.len()
    )));
}

fn handle_mdx_jsx_flow_element(
    components: &mut Vec<MarkdownItem>,
    mdx_jsx_flow_element: MdxJsxFlowElement,
) {
    components.push(MarkdownItem::text(&format!(
        "MdxJsxFlowElement {:?}",
        mdx_jsx_flow_element.children.len()
    )));
}

fn handle_list(components: &mut Vec<MarkdownItem>, list: List) {
    components.push(MarkdownItem::text(&format!(
        "List {:?}",
        list.children.len()
    )));
}

fn handle_mdx_js_esm(components: &mut Vec<MarkdownItem>, mdx_js_esm: MdxjsEsm) {
    components.push(MarkdownItem::text(&format!(
        "MdxjsEsm {:?}",
        mdx_js_esm.value
    )));
}

fn handle_toml(components: &mut Vec<MarkdownItem>, toml: Toml) {
    components.push(MarkdownItem::text(&format!("Toml {:?}", toml.value)));
}

fn handle_yaml(components: &mut Vec<MarkdownItem>, yaml: Yaml) {
    components.push(MarkdownItem::text(&format!("Yaml {:?}", yaml.value)));
}

fn handle_line_break(components: &mut Vec<MarkdownItem>, _line_break: Break) {
    components.push(MarkdownItem::empty());
}

fn handle_inline_code(components: &mut Vec<MarkdownItem>, inline_code: InlineCode) {
    components.push(MarkdownItem::text(&format!(
        "InlineCode {:?}",
        inline_code.value
    )));
}

fn handle_inline_math(components: &mut Vec<MarkdownItem>, inline_math: InlineMath) {
    components.push(MarkdownItem::text(&format!(
        "InlineMath {:?}",
        inline_math.value
    )));
}

fn handle_delete(components: &mut Vec<MarkdownItem>, delete: Delete) {
    components.push(MarkdownItem::text(&format!(
        "Delete {:?}",
        delete.children.len()
    )));
}

fn handle_emphasis(components: &mut Vec<MarkdownItem>, emphasis: Emphasis) {
    components.push(MarkdownItem::text(&format!(
        "Emphasis {:?}",
        emphasis.children.len()
    )));
}

fn handle_mdx_text_expressions(
    components: &mut Vec<MarkdownItem>,
    mdx_text_expressions: MdxTextExpression,
) {
    components.push(MarkdownItem::text(&format!(
        "MdxTextExpression {:?}",
        mdx_text_expressions.value
    )));
}

fn handle_footnote_reference(
    components: &mut Vec<MarkdownItem>,
    footnote_reference: FootnoteReference,
) {
    components.push(MarkdownItem::text(&format!(
        "FootnoteReference {:?}",
        footnote_reference
    )));
}

fn handle_html(components: &mut Vec<MarkdownItem>, html: Html) {
    components.push(MarkdownItem::text(&format!("Html {:?}", html.value)));
}

fn handle_image(components: &mut Vec<MarkdownItem>, image: Image) {
    components.push(MarkdownItem::text(&format!("Image {:?}", image)));
}

fn handle_image_reference(components: &mut Vec<MarkdownItem>, image_reference: ImageReference) {
    components.push(MarkdownItem::text(&format!(
        "ImageReference {:?}",
        image_reference
    )));
}

fn handle_mdx_jsx_text_element(
    components: &mut Vec<MarkdownItem>,
    mdx_jsx_text_element: MdxJsxTextElement,
) {
    components.push(MarkdownItem::text(&format!(
        "MdxJsxTextElement {:?} {}",
        mdx_jsx_text_element.name,
        mdx_jsx_text_element.children.len()
    )));
}

fn handle_link(components: &mut Vec<MarkdownItem>, link: Link) {
    components.push(MarkdownItem::text(&format!("Link {:?}", link)));
}

fn handle_link_reference(components: &mut Vec<MarkdownItem>, link_reference: LinkReference) {
    components.push(MarkdownItem::text(&format!(
        "LinkReference {:?}",
        link_reference
    )));
}

fn handle_strong(components: &mut Vec<MarkdownItem>, strong: Strong) {
    components.push(MarkdownItem::text(&format!("Strong {:?}", strong)));
}

fn handle_text(components: &mut Vec<MarkdownItem>, text: Text) {
    components.push(MarkdownItem::text(&format!("Text {:?}", text)));
}

fn handle_code(components: &mut Vec<MarkdownItem>, code: Code) {
    components.push(MarkdownItem::text(&format!("Code {:?}", code)));
}

fn handle_math(components: &mut Vec<MarkdownItem>, math: Math) {
    components.push(MarkdownItem::text(&format!("Math {:?}", math)));
}

fn handle_mdx_flow_expr(components: &mut Vec<MarkdownItem>, mdx_flow_expr: MdxFlowExpression) {
    components.push(MarkdownItem::text(&format!(
        "MdxFlowExpression {:?}",
        mdx_flow_expr
    )));
}

fn handle_heading(components: &mut Vec<MarkdownItem>, heading: Heading) {
    components.push(MarkdownItem::text(&format!("Heading {:?}", heading)));
}

fn handle_table(components: &mut Vec<MarkdownItem>, table: Table) {
    components.push(MarkdownItem::text(&format!("Table {:?}", table)));
}

fn handle_thematic_break(components: &mut Vec<MarkdownItem>, thematic_break: ThematicBreak) {
    components.push(MarkdownItem::text(&format!(
        "ThematicBreak {:?}",
        thematic_break
    )));
}

fn handle_table_row(components: &mut Vec<MarkdownItem>, table_row: TableRow) {
    components.push(MarkdownItem::text(&format!("TableRow {:?}", table_row)));
}

fn handle_table_cell(components: &mut Vec<MarkdownItem>, table_cell: TableCell) {
    components.push(MarkdownItem::text(&format!("TableCell {:?}", table_cell)));
}

fn handle_list_item(components: &mut Vec<MarkdownItem>, list_item: ListItem) {
    components.push(MarkdownItem::text(&format!("ListItem {:?}", list_item)));
}

fn handle_definition(components: &mut Vec<MarkdownItem>, definition: Definition) {
    components.push(MarkdownItem::text(&format!("Definition {:?}", definition)));
}

fn handle_paragraph(components: &mut Vec<MarkdownItem>, paragraph: Paragraph) {
    components.push(MarkdownItem::text(&format!("Paragraph {:?}", paragraph)));
}
