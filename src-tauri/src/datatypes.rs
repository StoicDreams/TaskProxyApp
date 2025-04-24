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
    pub navigation: Vec<ProjectNavItem>,
    pub variables: Vec<String>,
    pub data: HashMap<String, String>,
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
    pub data: HashMap<String, Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Project {
    pub name: String,
    pub path: String,
}

impl ProjectData {
    pub fn new() -> Self {
        ProjectData {
            id: String::new(),
            path: String::new(),
            current_page: String::from("/"),
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
//             icon: String::from("star|backing|theme:primary|shape:circle"),
//             url: Some(url),
//             children: None,
//         }
//     }
//     pub fn group() -> Self {
//         ProjectNavItem {
//             name: String::new(),
//             icon: String::from("star|backing|theme:primary|shape:circle"),
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
