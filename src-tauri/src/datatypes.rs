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
pub(crate) type SharedProjects = Arc<Mutex<Vec<ProjectFull>>>;
pub(crate) type SharedAppData = Arc<Mutex<TaskProxyData>>;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub(crate) struct ProjectData {
    pub id: String,
    pub path: String,
    pub navigation: String,
    pub variables: Vec<String>,
    pub data: HashMap<String, String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub(crate) struct TaskProxyData {
    pub is_saved: bool,
    pub save_interval_minutes: u64,
    pub data: HashMap<String, Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub(crate) struct ProjectFull {
    pub name: String,
    pub path: String,
    pub secrets: HashMap<String, SerializableSecret>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub(crate) struct Project {
    pub name: String,
    pub path: String,
}

impl ProjectData {
    pub fn new() -> Self {
        ProjectData {
            id: String::new(),
            path: String::new(),
            navigation: String::new(),
            variables: vec![],
            data: HashMap::new(),
        }
    }
}

impl TaskProxyData {
    pub fn new() -> Self {
        TaskProxyData {
            is_saved: false,
            save_interval_minutes: 20,
            data: HashMap::new(),
        }
    }
}

impl ProjectFull {
    pub fn new(name: &str, path: &str) -> Self {
        ProjectFull {
            name: String::from(name),
            path: String::from(path),
            secrets: HashMap::new(),
        }
    }
}
