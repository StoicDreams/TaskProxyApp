#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProjectPath {
    pub(crate) name: String,
    pub(crate) path: String,
}

impl ProjectPath {
    pub(crate) fn new(name: &str, path: &str) -> ProjectPath {
        ProjectPath {
            name: name.to_string(),
            path: path.to_string(),
        }
    }
}
