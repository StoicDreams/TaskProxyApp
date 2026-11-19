//! Imports markdown files from the open project as Task Proxy pages. A folder becomes pages nested in the navigation
//! as its files are nested in its subfolders, and a single file is added to the page that is open. The files
//! themselves are only read, never changed or removed.
//!
//! Imported markdown is saved the way the page editor saves a page: each heading and line break stands alone, and
//! everything else is wrapped in a `<webui-page-segment>` (see `splitMarkdownSegments` in `wc/page-handler.js`).
//! Relative links are rewritten for the page's new place in `.taskproxy/pages/`. A link to another file imported
//! with it opens that file's new page, and any other link or image keeps pointing at the same project file.

use crate::prelude::*;
use crate::services::projects::{current_project_path, get_project_docs};
use regex::Regex;
use std::collections::BTreeMap;
use std::sync::LazyLock;

const IMPORT_CONTEXT: &str = "Import Failed";
const PAGES_FOLDER: &str = ".taskproxy/pages";
/// From a page in `.taskproxy/pages/` back to the project's root.
const TO_ROOT: &str = "../../";
/// The most files one import takes, so choosing a huge folder by mistake can't flood the navigation.
const MAX_FILES: usize = 1000;
const FOLDER_ICON: &str = "folder";
const PAGE_ICON: &str = "file";

/// What a folder import did: the navigation to save, with the new pages in it, and the files it left out.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderImport {
    pub navigation: Vec<ProjectNavItem>,
    pub pages: usize,
    pub skipped: Vec<String>,
}

// Segments, as the page editor splits them.

static HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#{1,6}[ \t]+\S").unwrap());
static LINE_BREAK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^<webui-line\s*>\s*</webui-line>$").unwrap());
static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(```+|~~~+)").unwrap());
static COMPONENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*<([a-zA-Z][a-zA-Z0-9-]*)[\s>/]").unwrap());
static ONE_LINE_SEGMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*<webui-page-segment\b.*</webui-page-segment>\s*$").unwrap()
});
const VOID_TAGS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];

/// The tag that opens a component at the start of this line, if any.
fn component_tag(line: &str) -> Option<String> {
    let tag = COMPONENT.captures(line)?.get(1)?.as_str().to_lowercase();
    (!VOID_TAGS.contains(&tag.as_str())).then_some(tag)
}

/// How much this line changes the number of open tags with this name.
fn tag_depth_change(line: &str, tag: &str) -> i32 {
    let lower = line.to_lowercase();
    let bytes = lower.as_bytes();
    let mut change = 0;
    let mut index = 0;
    while let Some(found) = lower[index..].find('<') {
        let start = index + found + 1;
        index = start;
        let closing = bytes.get(start) == Some(&b'/');
        let name_start = start + usize::from(closing);
        if !lower[name_start..].starts_with(tag) {
            continue;
        }
        let after = name_start + tag.len();
        if !matches!(bytes.get(after), Some(b' ' | b'\t' | b'>' | b'/')) {
            continue;
        }
        let Some(end) = lower[after..].find('>').map(|end| after + end) else {
            break;
        };
        if closing {
            change -= 1;
        } else if bytes[end - 1] != b'/' {
            change += 1;
        }
        index = end + 1;
    }
    change
}

/// The last line of the fenced code block or multi-line component that starts at `index`.
fn block_end(lines: &[&str], index: usize) -> usize {
    let line = lines[index];
    if let Some(fence) = FENCE.captures(line) {
        let fence = fence[1].to_string();
        let mut end = index + 1;
        while end < lines.len() && !lines[end].trim_start().starts_with(&fence) {
            end += 1;
        }
        return end.min(lines.len() - 1);
    }
    let Some(tag) = component_tag(line) else {
        return index;
    };
    let mut depth = tag_depth_change(line, &tag);
    let mut end = index;
    let mut in_fence = false;
    while depth > 0 && end < lines.len() - 1 {
        end += 1;
        // Tags shown as code examples do not open or close anything.
        if FENCE.is_match(lines[end]) {
            in_fence = !in_fence;
        } else if !in_fence {
            depth += tag_depth_change(lines[end], &tag);
        }
    }
    // An unclosed plain tag is prose such as "<string> values", not a component.
    if depth > 0 && !tag.contains('-') {
        return index;
    }
    end
}

/// Splits markdown into page segments: headings, line breaks, and page segments, with any other content wrapped in a
/// page segment that ends where the next one, a heading, or a line break starts. Code blocks and components are never
/// split. The same as `splitMarkdownSegments` in `wc/page-handler.js`.
pub(crate) fn split_segments(markdown: &str) -> Vec<String> {
    let normalized = markdown.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut results = Vec::new();
    let mut body: Vec<&str> = Vec::new();
    let flush = |body: &mut Vec<&str>, results: &mut Vec<String>| {
        let start = body.iter().position(|line| !line.trim().is_empty());
        let end = body.iter().rposition(|line| !line.trim().is_empty());
        if let (Some(start), Some(end)) = (start, end) {
            results.push(format!(
                "<webui-page-segment>\n\n{}\n\n</webui-page-segment>",
                body[start..=end].join("\n")
            ));
        }
        body.clear();
    };
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        if HEADING.is_match(line) {
            flush(&mut body, &mut results);
            results.push(line.trim_end().to_string());
            index += 1;
            continue;
        }
        if LINE_BREAK.is_match(line.trim()) {
            flush(&mut body, &mut results);
            results.push(line.trim().to_string());
            index += 1;
            continue;
        }
        let end = block_end(&lines, index);
        let block = &lines[index..=end];
        let is_segment = (component_tag(line).as_deref() == Some("webui-page-segment")
            && end > index)
            || ONE_LINE_SEGMENT.is_match(line);
        if is_segment {
            flush(&mut body, &mut results);
            results.push(block.join("\n").trim().to_string());
        } else {
            body.extend_from_slice(block);
        }
        index = end + 1;
    }
    flush(&mut body, &mut results);
    results
}

// Links.

static INLINE_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\]\((\s*)(<[^>\n]*>|[^\s)]+)").unwrap());
static REFERENCE_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\s{0,3}\[[^\]]+\]:\s*)(<[^>\n]*>|\S+)").unwrap());
static HTML_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(\b(?:src|href|poster)\s*=\s*)("[^"]*"|'[^']*')"#).unwrap());
static SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:").unwrap());

/// Where links in one file point: the file's folder in the project, and the pages made from the files imported with it.
struct Links<'a> {
    folder: Vec<String>,
    pages: &'a HashMap<String, String>,
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&text[index + 1..index + 3], 16)
        {
            decoded.push(byte);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).unwrap_or_else(|_| text.to_string())
}

fn percent_encode(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/!$&'*+,;=:@".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{:02X}", byte));
        }
    }
    encoded
}

/// Resolves `path` from `folder`, both relative to the project's root. None when it leaves the project.
fn resolve(folder: &[String], path: &str) -> Option<String> {
    let mut parts: Vec<String> = folder.to_vec();
    for part in path.replace('\\', "/").split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            name => parts.push(name.to_string()),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

impl Links<'_> {
    /// The link's new target, or None to leave it as written: links to websites, within the page, from the app's
    /// root, or out of the project.
    fn rewrite(&self, target: &str) -> Option<String> {
        let (wrapped, target) = match target.strip_prefix('<').and_then(|t| t.strip_suffix('>')) {
            Some(inner) => (true, inner),
            None => (false, target),
        };
        if target.is_empty() || target.starts_with(['#', '/', '\\', '{']) || SCHEME.is_match(target)
        {
            return None;
        }
        let split = target.find(['#', '?']).unwrap_or(target.len());
        let (path, suffix) = target.split_at(split);
        let resolved = resolve(&self.folder, &percent_decode(path))?;
        let rewritten = match self.pages.get(&resolved) {
            Some(url) => format!("{}{}", url, suffix),
            None => format!("{}{}{}", TO_ROOT, percent_encode(&resolved), suffix),
        };
        Some(if wrapped {
            format!("<{}>", rewritten)
        } else {
            rewritten
        })
    }

    fn rewrite_text(&self, text: &str) -> String {
        let text = INLINE_LINK.replace_all(text, |caps: &regex::Captures| {
            let target = self
                .rewrite(&caps[2])
                .unwrap_or_else(|| caps[2].to_string());
            format!("]({}{}", &caps[1], target)
        });
        let text = REFERENCE_LINK.replace_all(&text, |caps: &regex::Captures| {
            let target = self
                .rewrite(&caps[2])
                .unwrap_or_else(|| caps[2].to_string());
            format!("{}{}", &caps[1], target)
        });
        HTML_URL
            .replace_all(&text, |caps: &regex::Captures| {
                let quoted = &caps[2];
                let quote = &quoted[..1];
                let value = &quoted[1..quoted.len() - 1];
                let target = self.rewrite(value).unwrap_or_else(|| value.to_string());
                format!("{}{}{}{}", &caps[1], quote, target, quote)
            })
            .into_owned()
    }

    /// Rewrites one line outside code blocks, leaving inline code as written.
    fn rewrite_line(&self, line: &str) -> String {
        let mut result = String::with_capacity(line.len());
        let mut rest = line;
        while let Some(start) = rest.find('`') {
            let ticks = rest[start..]
                .bytes()
                .take_while(|byte| *byte == b'`')
                .count();
            let fence = &rest[start..start + ticks];
            let after = start + ticks;
            let Some(close) = rest[after..].find(fence) else {
                break;
            };
            let end = after + close + ticks;
            result.push_str(&self.rewrite_text(&rest[..start]));
            result.push_str(&rest[start..end]);
            rest = &rest[end..];
        }
        result.push_str(&self.rewrite_text(rest));
        result
    }

    fn rewrite_markdown(&self, markdown: &str) -> String {
        let mut fence: Option<String> = None;
        markdown
            .split('\n')
            .map(|line| {
                if let Some(open) = &fence {
                    if line.trim_start().starts_with(open.as_str()) {
                        fence = None;
                    }
                    return line.to_string();
                }
                if let Some(caps) = FENCE.captures(line) {
                    fence = Some(caps[1].to_string());
                    return line.to_string();
                }
                self.rewrite_line(line)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

// Pages.

static PAGE_DATA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)^<webui-data[\s\S]*?</webui-data>").unwrap());
static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#[ \t]+(.*?)[ \t#]*$").unwrap());

/// The file's first top-level heading, outside code blocks.
fn first_heading(markdown: &str) -> Option<String> {
    let mut fence: Option<String> = None;
    for line in markdown.lines() {
        if let Some(open) = &fence {
            if line.trim_start().starts_with(open.as_str()) {
                fence = None;
            }
            continue;
        }
        if let Some(caps) = FENCE.captures(line) {
            fence = Some(caps[1].to_string());
            continue;
        }
        if let Some(caps) = TITLE.captures(line) {
            let title = caps[1].trim();
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
    }
    None
}

/// A file name made readable: `getting-started.md` is "Getting Started".
fn name_from_file(file: &str) -> String {
    let stem = file.rsplit('/').next().unwrap_or(file);
    let stem = stem
        .rsplit_once('.')
        .map_or(stem, |(stem, _)| stem)
        .replace(['-', '_'], " ");
    let words: Vec<String> = stem
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map_or_else(String::new, |first| {
                first.to_uppercase().collect::<String>() + chars.as_str()
            })
        })
        .collect();
    if words.is_empty() {
        file.to_string()
    } else {
        words.join(" ")
    }
}

/// A Task Proxy page's markdown already starts with its title and subtitle, which an import keeps.
fn split_page_data(markdown: &str) -> (Option<String>, String) {
    let trimmed = markdown.replace("\r\n", "\n").trim().to_string();
    match PAGE_DATA.find(&trimmed) {
        Some(found) => (
            Some(found.as_str().to_string()),
            trimmed[found.end()..].trim().to_string(),
        ),
        None => (None, trimmed),
    }
}

/// A project file's markdown, with its links rewritten, as page segments joined as the page editor saves them.
fn page_body(content: &str, links: &Links) -> String {
    split_segments(&links.rewrite_markdown(content)).join("\n\n")
}

fn page_markdown(name: &str, content: &str, links: &Links) -> String {
    let (data, content) = split_page_data(content);
    let data = data.unwrap_or_else(|| {
        format!(
            r#"<webui-data data-page-title="{}" data-page-subtitle=""></webui-data>"#,
            escape_attribute(name)
        )
    });
    let body = page_body(&content, links);
    if body.is_empty() {
        data
    } else {
        format!("{}\n\n{}", data, body)
    }
}

fn escape_attribute(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn folder_of(file: &str) -> Vec<String> {
    let mut parts: Vec<String> = file.split('/').map(String::from).collect();
    parts.pop();
    parts
}

// The navigation.

/// A folder, or a page made from a file, before it has a place in the navigation.
enum Node {
    Folder(String, BTreeMap<String, Node>),
    Page(String),
}

/// Pages come before folders, a folder's README or index first, then by name.
fn sort_key(name: &str, is_folder: bool) -> (bool, bool, String) {
    let lower = name.to_lowercase();
    let first = !is_folder && matches!(lower.as_str(), "readme.md" | "index.md");
    (is_folder, !first, lower)
}

fn add_file(tree: &mut BTreeMap<String, Node>, parts: &[&str], file: &str) {
    match parts {
        [] => {}
        [name] => {
            tree.insert(name.to_string(), Node::Page(file.to_string()));
        }
        [folder, rest @ ..] => {
            let entry = tree
                .entry(format!("/{}", folder))
                .or_insert_with(|| Node::Folder(folder.to_string(), BTreeMap::new()));
            if let Node::Folder(_, children) = entry {
                add_file(children, rest, file);
            }
        }
    }
}

fn nav_items(
    tree: &BTreeMap<String, Node>,
    page: &mut impl FnMut(&str) -> Option<ProjectNavItem>,
) -> Vec<ProjectNavItem> {
    let mut nodes: Vec<&Node> = tree.values().collect();
    nodes.sort_by_cached_key(|node| match node {
        Node::Folder(name, _) => sort_key(name, true),
        Node::Page(file) => sort_key(file.rsplit('/').next().unwrap_or(file), false),
    });
    nodes
        .into_iter()
        .filter_map(|node| match node {
            Node::Page(file) => page(file),
            Node::Folder(name, children) => {
                let children = nav_items(children, page);
                (!children.is_empty()).then(|| ProjectNavItem {
                    name: name.clone(),
                    icon: FOLDER_ICON.to_string(),
                    url: None,
                    children: Some(children),
                })
            }
        })
        .collect()
}

fn same_name(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// Adds `items` to `navigation`, putting a folder's pages into a folder already there with the same name, at the
/// same level. Pages are always added as new ones.
fn merge_navigation(navigation: &mut Vec<ProjectNavItem>, items: Vec<ProjectNavItem>) {
    for item in items {
        if item.url.is_none()
            && let Some(existing) = navigation
                .iter_mut()
                .find(|existing| existing.url.is_none() && same_name(&existing.name, &item.name))
        {
            merge_navigation(
                existing.children.get_or_insert_with(Vec::new),
                item.children.unwrap_or_default(),
            );
            continue;
        }
        navigation.push(item);
    }
}

/// The folder chosen, as a path relative to the project's root: "" for the root itself.
fn checked_folder(folder: &str) -> Result<String, String> {
    let trimmed = folder.trim().trim_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        return Ok(String::new());
    }
    let relative = safe_relative_path(trimmed)?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

/// Imports every markdown file in `folder` (relative to `root`, with "" the whole project) as pages, nested as the
/// files are in its subfolders, under a folder named `parent` or at the top of the navigation.
fn import_folder(
    root: &Path,
    folder: &str,
    parent: Option<&str>,
    mut navigation: Vec<ProjectNavItem>,
) -> Result<FolderImport, String> {
    let folder = checked_folder(folder)?;
    ensure_inside_root(root, &root.join(&folder))?;
    let prefix = if folder.is_empty() {
        String::new()
    } else {
        format!("{}/", folder)
    };
    // The same files the Docs page lists: markdown files git doesn't ignore, outside build and data folders.
    let files: Vec<String> = get_project_docs(&root.to_string_lossy())
        .into_iter()
        .filter(|file| file.starts_with(&prefix))
        .collect();
    if files.is_empty() {
        return Err(format!(
            "There are no markdown files in {}.",
            if folder.is_empty() {
                "this project"
            } else {
                &folder
            }
        ));
    }
    if files.len() > MAX_FILES {
        return Err(format!(
            "{} has {} markdown files, more than the {} one import takes. Choose a folder inside it.",
            if folder.is_empty() {
                "This project"
            } else {
                &folder
            },
            files.len(),
            MAX_FILES
        ));
    }
    let mut skipped = Vec::new();
    let mut contents = HashMap::new();
    for file in &files {
        let path = root.join(safe_relative_path(file)?);
        let read = ensure_inside_root(root, &path).and_then(|_| {
            let size = fs::metadata(&path).map_err(|err| err.to_string())?.len();
            if size > crate::services::projects::TEXT_MAX_BYTES {
                return Err(String::from("too large"));
            }
            fs::read_to_string(&path).map_err(|_| String::from("not text"))
        });
        match read {
            Ok(content) => {
                contents.insert(file.clone(), content);
            }
            Err(err) => skipped.push(format!("{} ({})", file, err)),
        }
    }
    let pages: HashMap<String, String> = contents
        .keys()
        .map(|file| (file.clone(), format!("/{}", Uuid::now_v7())))
        .collect();
    let mut tree = BTreeMap::new();
    for file in contents.keys() {
        let parts: Vec<&str> = file[prefix.len()..].split('/').collect();
        add_file(&mut tree, &parts, file);
    }
    let mut written: Vec<PathBuf> = Vec::new();
    let mut failure = None;
    let items = nav_items(&tree, &mut |file| {
        if failure.is_some() {
            return None;
        }
        let content = &contents[file];
        let name = first_heading(content).unwrap_or_else(|| name_from_file(file));
        let url = pages[file].clone();
        let links = Links {
            folder: folder_of(file),
            pages: &pages,
        };
        let page_file = root.join(PAGES_FOLDER).join(format!("{}.md", &url[1..]));
        let mut markdown = page_markdown(&name, content, &links);
        markdown.push('\n');
        if let Err(err) = write_atomic(&page_file, markdown.as_bytes()) {
            failure = Some(format!("{}: {}", file, err));
            return None;
        }
        written.push(page_file);
        Some(ProjectNavItem {
            name,
            icon: PAGE_ICON.to_string(),
            url: Some(url),
            children: None,
        })
    });
    if let Some(err) = failure {
        // A failed import leaves no pages behind that nothing links to.
        written.iter().for_each(|file| _ = fs::remove_file(file));
        return Err(err);
    }
    let count = written.len();
    let items = match parent.map(str::trim).filter(|name| !name.is_empty()) {
        Some(parent) => vec![ProjectNavItem {
            name: parent.to_string(),
            icon: FOLDER_ICON.to_string(),
            url: None,
            children: Some(items),
        }],
        None => items,
    };
    merge_navigation(&mut navigation, items);
    Ok(FolderImport {
        navigation,
        pages: count,
        skipped,
    })
}

/// A markdown file in the project, as page segments with its links rewritten for a page, to add to the open page.
fn import_file(root: &Path, file: &str) -> Result<String, String> {
    let relative = safe_relative_path(file)?;
    let is_markdown = relative
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
    if !is_markdown {
        return Err(format!("'{}' isn't a markdown file.", file));
    }
    let content = crate::services::projects::read_project_file(root, file)?;
    let file = relative.to_string_lossy().replace('\\', "/");
    let pages = HashMap::new();
    let links = Links {
        folder: folder_of(&file),
        pages: &pages,
    };
    // A Task Proxy page's own title stays with that page.
    let (_, content) = split_page_data(&content);
    Ok(page_body(&content, &links))
}

/// Imports a folder of the open project's markdown files as pages, and gives the navigation to save with them.
#[tauri::command]
pub(crate) async fn import_page_folder(
    state: State<'_, CurrentProject>,
    folder: String,
    parent: Option<String>,
    navigation: Vec<ProjectNavItem>,
) -> Result<FolderImport, String> {
    let root = current_project_path(&state, IMPORT_CONTEXT)?;
    task::spawn_blocking(move || import_folder(&root, &folder, parent.as_deref(), navigation))
        .await
        .map_err(|err| format!("{}", err))?
        .map_err(|err| format!("{}: {}", IMPORT_CONTEXT, err))
}

/// One of the open project's markdown files, ready to add to a page.
#[tauri::command]
pub(crate) async fn import_page_file(
    state: State<'_, CurrentProject>,
    file: String,
) -> Result<String, String> {
    let root = current_project_path(&state, IMPORT_CONTEXT)?;
    task::spawn_blocking(move || import_file(&root, &file))
        .await
        .map_err(|err| format!("{}", err))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (path, content) in files {
            let file = dir.path().join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, content).unwrap();
        }
        dir
    }

    fn page(root: &Path, item: &ProjectNavItem) -> String {
        let id = &item.url.as_ref().unwrap()[1..];
        fs::read_to_string(root.join(PAGES_FOLDER).join(format!("{}.md", id))).unwrap()
    }

    fn names(items: &[ProjectNavItem]) -> Vec<String> {
        items.iter().map(|item| item.name.clone()).collect()
    }

    fn existing(name: &str, children: Vec<ProjectNavItem>) -> ProjectNavItem {
        ProjectNavItem {
            name: name.into(),
            icon: "star".into(),
            url: None,
            children: Some(children),
        }
    }

    fn existing_page(name: &str) -> ProjectNavItem {
        ProjectNavItem {
            name: name.into(),
            icon: "star".into(),
            url: Some("/old".into()),
            children: None,
        }
    }

    #[test]
    fn content_outside_segments_is_wrapped_and_headings_stand_alone() {
        let markdown = "Intro text\n\n# Title\nBody one\n\n```md\n# not a heading\n```\n<webui-line></webui-line>\n<webui-page-segment>\n\nKept\n\n</webui-page-segment>\n<webui-quote>\nA\n\nB\n</webui-quote>";
        assert_eq!(
            split_segments(markdown),
            vec![
                "<webui-page-segment>\n\nIntro text\n\n</webui-page-segment>",
                "# Title",
                "<webui-page-segment>\n\nBody one\n\n```md\n# not a heading\n```\n\n</webui-page-segment>",
                "<webui-line></webui-line>",
                "<webui-page-segment>\n\nKept\n\n</webui-page-segment>",
                "<webui-page-segment>\n\n<webui-quote>\nA\n\nB\n</webui-quote>\n\n</webui-page-segment>",
            ]
        );
        assert_eq!(split_segments("  \n\n"), Vec::<String>::new());
    }

    #[test]
    fn pages_are_named_by_their_first_heading_or_their_file() {
        assert_eq!(
            first_heading("```\n# Code\n```\n## Sub\n# The Title #\n"),
            Some("The Title".into())
        );
        assert_eq!(first_heading("## Only a subheading"), None);
        assert_eq!(name_from_file("docs/getting-started.md"), "Getting Started");
        assert_eq!(name_from_file("my_notes v2.md"), "My Notes V2");
        assert_eq!(name_from_file("README.md"), "README");
    }

    #[test]
    fn links_point_at_imported_pages_and_other_files_from_the_pages_folder() {
        let pages = HashMap::from([
            ("docs/guide/setup.md".to_string(), "/page-setup".to_string()),
            ("docs/My File.md".to_string(), "/page-file".to_string()),
        ]);
        let links = Links {
            folder: vec!["docs".into(), "guide".into()],
            pages: &pages,
        };
        let markdown = "See [setup](setup.md#install) and [file](../My%20File.md).\n\
            ![logo](../img/logo.png \"Logo\") [site](https://example.com) [top](#top) [app](/settings)\n\
            [ref]: ./notes.txt\n\
            <img src=\"../img/a b.png\"> `[code](setup.md)`\n\
            ```\n[fenced](setup.md)\n```\n\
            [out](../../../outside.md)";
        assert_eq!(
            links.rewrite_markdown(markdown),
            "See [setup](/page-setup#install) and [file](/page-file).\n\
            ![logo](../../docs/img/logo.png \"Logo\") [site](https://example.com) [top](#top) [app](/settings)\n\
            [ref]: ../../docs/guide/notes.txt\n\
            <img src=\"../../docs/img/a%20b.png\"> `[code](setup.md)`\n\
            ```\n[fenced](setup.md)\n```\n\
            [out](../../../outside.md)"
        );
    }

    #[test]
    fn a_folder_becomes_pages_nested_as_its_files_are() {
        let dir = project(&[
            (
                "docs/README.md",
                "# Docs Home\n\nWelcome. See [setup](guide/setup.md).",
            ),
            ("docs/zeta.md", "No heading here"),
            (
                "docs/guide/setup.md",
                "# Setup\n\nBack to [home](../README.md).",
            ),
            ("docs/guide/deep/more.md", "## More"),
            ("docs/empty/notes.txt", "not markdown"),
            ("other.md", "# Not in the folder"),
        ]);
        let result =
            import_folder(dir.path(), "docs", None, vec![existing_page("Existing")]).unwrap();
        assert_eq!(result.pages, 4);
        assert!(result.skipped.is_empty());
        let nav = &result.navigation;
        assert_eq!(names(nav), vec!["Existing", "Docs Home", "Zeta", "guide"]);
        let guide = nav[3].children.as_ref().unwrap();
        assert_eq!(nav[3].icon, FOLDER_ICON);
        assert_eq!(guide[0].icon, PAGE_ICON);
        assert_eq!(names(guide), vec!["Setup", "deep"]);
        assert_eq!(names(guide[1].children.as_ref().unwrap()), vec!["More"]);
        let home = page(dir.path(), &nav[1]);
        let setup_url = guide[0].url.clone().unwrap();
        assert_eq!(
            home,
            format!(
                "<webui-data data-page-title=\"Docs Home\" data-page-subtitle=\"\"></webui-data>\n\n# Docs Home\n\n<webui-page-segment>\n\nWelcome. See [setup]({}).\n\n</webui-page-segment>\n",
                setup_url
            )
        );
        assert!(
            page(dir.path(), &guide[0])
                .contains(&format!("[home]({})", nav[1].url.as_ref().unwrap()))
        );
        // The originals are left as they were.
        assert_eq!(
            fs::read_to_string(dir.path().join("docs/README.md")).unwrap(),
            "# Docs Home\n\nWelcome. See [setup](guide/setup.md)."
        );
    }

    #[test]
    fn a_parent_folder_holds_the_import_and_same_named_folders_merge() {
        let dir = project(&[("docs/a.md", "# A"), ("docs/guide/b.md", "# B")]);
        let navigation = vec![existing(
            "Docs",
            vec![
                existing_page("Old"),
                existing("Guide", vec![existing_page("Older")]),
            ],
        )];
        let result = import_folder(dir.path(), "docs/", Some(" docs "), navigation).unwrap();
        let nav = &result.navigation;
        assert_eq!(names(nav), vec!["Docs"]);
        let docs = nav[0].children.as_ref().unwrap();
        assert_eq!(names(docs), vec!["Old", "Guide", "A"]);
        assert_eq!(
            names(docs[1].children.as_ref().unwrap()),
            vec!["Older", "B"]
        );
        // Pages are always added, even when one has the same name.
        let again = import_folder(dir.path(), "docs", Some("Docs"), result.navigation).unwrap();
        assert_eq!(
            names(again.navigation[0].children.as_ref().unwrap()),
            vec!["Old", "Guide", "A", "A"]
        );
    }

    #[test]
    fn the_whole_project_can_be_imported_but_never_its_own_pages() {
        let dir = project(&[
            ("README.md", "# Read Me"),
            (".taskproxy/pages/123.md", "# A page"),
            ("node_modules/x/README.md", "# Dependency"),
        ]);
        let result = import_folder(dir.path(), "", None, vec![]).unwrap();
        assert_eq!(names(&result.navigation), vec!["Read Me"]);
    }

    #[test]
    fn folders_outside_the_project_or_without_markdown_are_refused() {
        let dir = project(&[("docs/notes.txt", "text")]);
        assert!(import_folder(dir.path(), "../", None, vec![]).is_err());
        assert!(import_folder(dir.path(), "/etc", None, vec![]).is_err());
        assert_eq!(
            import_folder(dir.path(), "docs", None, vec![]).unwrap_err(),
            "There are no markdown files in docs."
        );
        assert!(!dir.path().join(PAGES_FOLDER).exists());
    }

    #[test]
    fn a_file_that_is_not_text_is_skipped_and_named() {
        let dir = project(&[("docs/a.md", "# A")]);
        fs::write(dir.path().join("docs/b.md"), [0xff, 0xfe, 0x00]).unwrap();
        let result = import_folder(dir.path(), "docs", None, vec![]).unwrap();
        assert_eq!(result.pages, 1);
        assert_eq!(result.skipped, vec!["docs/b.md (not text)"]);
    }

    #[test]
    fn a_single_file_is_segments_with_links_from_the_pages_folder() {
        let dir = project(&[
            ("docs/note.md", "Intro\n\n## Part\n\n![x](img/x.png)"),
            (
                "docs/page.md",
                "<webui-data data-page-title=\"T\"></webui-data>\n\nBody",
            ),
            ("docs/plain.txt", "text"),
        ]);
        assert_eq!(
            import_file(dir.path(), "docs/note.md").unwrap(),
            "<webui-page-segment>\n\nIntro\n\n</webui-page-segment>\n\n## Part\n\n<webui-page-segment>\n\n![x](../../docs/img/x.png)\n\n</webui-page-segment>"
        );
        assert_eq!(
            import_file(dir.path(), "docs/page.md").unwrap(),
            "<webui-page-segment>\n\nBody\n\n</webui-page-segment>"
        );
        assert!(import_file(dir.path(), "docs/plain.txt").is_err());
        assert!(import_file(dir.path(), "../outside.md").is_err());
    }
}
