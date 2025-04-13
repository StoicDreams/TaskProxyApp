use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct SerializableSecret(pub SecretString);

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

pub type SharedProjects = Arc<Mutex<Vec<ProjectFull>>>;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProjectFull {
    pub name: String,
    pub path: String,
    pub secrets: HashMap<String, SerializableSecret>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Project {
    pub name: String,
    pub path: String,
}
