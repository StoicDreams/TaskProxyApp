use crate::prelude::*;

#[derive(Clone, Debug)]
pub(crate) struct SerializableSecret(pub SecretString);

impl Serialize for SerializableSecret {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        // WARNING: This will expose the secret in the serialized data
        serializer.serialize_str(self.0.expose_secret())
    }
}

impl<'de> Deserialize<'de> for SerializableSecret {
    fn deserialize<D>(deserializer: D) -> Result<SerializableSecret, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(SerializableSecret(SecretString::new(s.into())))
    }
}

pub(crate) type CurrentProject = Arc<Mutex<ProjectData>>;
pub(crate) type SharedProjects = Arc<Mutex<Vec<Project>>>;
pub(crate) type SharedAppData = Arc<Mutex<TaskProxyData>>;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectData {
    pub id: String,
    pub path: String,
    pub current_page: String,
    pub docs: Vec<String>,
    pub navigation: Vec<ProjectNavItem>,
    pub variables: Vec<String>,
    pub data: HashMap<String, Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectNavItem {
    #[serde(alias = "Name")]
    name: String,
    #[serde(alias = "Icon")]
    icon: String,
    #[serde(alias = "Url")]
    url: Option<String>,
    #[serde(alias = "Children")]
    children: Option<Vec<ProjectNavItem>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskProxyData {
    pub is_saved: bool,
    pub save_interval_minutes: u64,
    pub variables: Vec<String>,
    pub data: HashMap<String, Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Project {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DropdownOption {
    pub value: String,
    pub display: String,
}

impl ProjectData {
    pub fn new() -> Self {
        ProjectData {
            id: String::new(),
            path: String::new(),
            current_page: String::from("/"),
            docs: Vec::new(),
            navigation: Vec::new(),
            variables: Vec::new(),
            data: HashMap::new(),
        }
    }
}

// impl ProjectNavItem {
//     pub fn new() -> Self {
//         let url = format!("/{}", newid());
//         ProjectNavItem {
//             name: String::new(),
//             icon: String::from("circle_star|backing|theme:primary"),
//             url: Some(url),
//             children: None,
//         }
//     }
//     pub fn group() -> Self {
//         ProjectNavItem {
//             name: String::new(),
//             icon: String::from("circle_star|backing|theme:primary"),
//             url: None,
//             children: Some(Vec::new()),
//         }
//     }
// }

impl TaskProxyData {
    pub fn new() -> Self {
        TaskProxyData {
            is_saved: false,
            save_interval_minutes: 20,
            variables: Vec::new(),
            data: HashMap::new(),
        }
    }
}

impl Project {
    pub fn new(name: &str, path: &str) -> Self {
        Project {
            name: String::from(name),
            path: String::from(path),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_data_uses_camel_case_and_drops_unknown_fields() {
        let json = r#"{"id":"1","path":"/p","currentPage":"/x","docs":[],"navigation":[],"variables":["a|text|"],"data":{"a":"b"},"unknown":5}"#;
        let data: ProjectData = serde_json::from_str(json).unwrap();
        assert_eq!(data.current_page, "/x");
        let out = serde_json::to_string(&data).unwrap();
        assert!(out.contains("\"currentPage\":\"/x\""));
        assert!(!out.contains("unknown"));
    }

    #[test]
    fn navigation_reads_both_name_styles_and_keeps_nesting() {
        let json = r#"[{"Name":"Folder","Icon":"i","Url":null,"Children":[{"name":"Page","icon":"j","url":"/p","children":null}]}]"#;
        let nav: Vec<ProjectNavItem> = serde_json::from_str(json).unwrap();
        let out = serde_json::to_value(&nav).unwrap();
        assert_eq!(out[0]["name"], "Folder");
        assert_eq!(out[0]["children"][0]["url"], "/p");
    }

    #[test]
    fn new_data_has_sensible_defaults() {
        let data = TaskProxyData::new();
        assert!(!data.is_saved);
        assert_eq!(data.save_interval_minutes, 20);
        assert_eq!(ProjectData::new().current_page, "/");
    }
}
