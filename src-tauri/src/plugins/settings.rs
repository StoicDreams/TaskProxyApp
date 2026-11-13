//! A plugin's settings, kept per project. The user enters them as a sign-in, such as a Jira site, email, and
//! token, and each project uses one sign-in or none, so a project only reaches the accounts it was set up with.
//! Projects can share a sign-in.
//!
//! The file was once one set of values for every project. That set becomes a sign-in for the project that is
//! open when it is first read.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignIn {
    pub values: HashMap<String, String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginSettings {
    /// Each sign-in, by an id that never changes.
    #[serde(default)]
    pub sign_ins: BTreeMap<String, SignIn>,
    /// The sign-in each project uses, by project id.
    #[serde(default)]
    pub projects: HashMap<String, String>,
}

impl PluginSettings {
    /// Reads the file. An old file of plain values becomes a sign-in for `project`, the one open now.
    pub fn read(bytes: &[u8], project: Option<&str>) -> Result<Self, String> {
        if bytes.is_empty() {
            return Ok(Self::default());
        }
        let value: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|err| err.to_string())?;
        if value.get("signIns").is_some() || value.get("projects").is_some() {
            return serde_json::from_value(value).map_err(|err| err.to_string());
        }
        let values: HashMap<String, String> =
            serde_json::from_value(value).map_err(|err| err.to_string())?;
        let mut settings = Self::default();
        if values.values().any(|value| !value.is_empty()) {
            let id = settings.add(values);
            if let Some(project) = project.filter(|project| !project.is_empty()) {
                settings.projects.insert(project.to_string(), id);
            }
        }
        Ok(settings)
    }

    fn add(&mut self, values: HashMap<String, String>) -> String {
        let mut number = self.sign_ins.len() + 1;
        while self.sign_ins.contains_key(&format!("sign-in-{}", number)) {
            number += 1;
        }
        let id = format!("sign-in-{}", number);
        self.sign_ins.insert(id.clone(), SignIn { values });
        id
    }

    /// The sign-in a project uses, if any.
    pub fn for_project(&self, project: Option<&str>) -> Option<(&String, &SignIn)> {
        let id = self.projects.get(project?)?;
        self.sign_ins.get_key_value(id)
    }

    /// The values the project's sign-in holds, or none.
    pub fn values(&self, project: Option<&str>) -> HashMap<String, String> {
        self.for_project(project)
            .map(|(_, sign_in)| sign_in.values.clone())
            .unwrap_or_default()
    }

    /// Saves values to the project's sign-in, making one for it when it has none. A key left out keeps its value,
    /// and an empty value removes it.
    pub fn save(&mut self, project: &str, values: HashMap<String, String>) {
        let id = match self
            .projects
            .get(project)
            .filter(|id| self.sign_ins.contains_key(*id))
        {
            Some(id) => id.clone(),
            None => {
                let id = self.add(HashMap::new());
                self.projects.insert(project.to_string(), id.clone());
                id
            }
        };
        let sign_in = self.sign_ins.entry(id).or_default();
        for (key, value) in values {
            let value = value.trim().to_string();
            if value.is_empty() {
                sign_in.values.remove(&key);
            } else {
                sign_in.values.insert(key, value);
            }
        }
    }

    /// Has the project use an existing sign-in, or none. A sign-in no project uses any more is forgotten.
    pub fn link(&mut self, project: &str, sign_in: Option<&str>) -> Result<(), String> {
        match sign_in {
            Some(id) if !self.sign_ins.contains_key(id) => {
                return Err(String::from("That sign-in no longer exists."));
            }
            Some(id) => {
                self.projects.insert(project.to_string(), id.to_string());
            }
            None => {
                self.projects.remove(project);
            }
        }
        let used: Vec<String> = self.projects.values().cloned().collect();
        self.sign_ins.retain(|id, _| used.contains(id));
        Ok(())
    }

    /// How many projects use each sign-in.
    pub fn uses(&self, id: &str) -> usize {
        self.projects.values().filter(|used| *used == id).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn old_settings_become_a_sign_in_for_the_open_project() {
        let old = br#"{"jira_site":"team","jira_api_token":"secret"}"#;
        let settings = PluginSettings::read(old, Some("p1")).unwrap();
        assert_eq!(
            settings.values(Some("p1")),
            values(&[("jira_site", "team"), ("jira_api_token", "secret")])
        );
        assert!(settings.values(Some("p2")).is_empty());
        // With no project open, the sign-in waits for one to use it.
        let waiting = PluginSettings::read(old, None).unwrap();
        assert_eq!(waiting.sign_ins.len(), 1);
        assert!(waiting.projects.is_empty());
        assert_eq!(
            PluginSettings::read(b"{}", Some("p1")).unwrap(),
            PluginSettings::default()
        );
        assert_eq!(
            PluginSettings::read(b"", Some("p1")).unwrap(),
            PluginSettings::default()
        );
        // A new file reads back as it was written.
        let written = serde_json::to_vec(&settings).unwrap();
        assert_eq!(
            PluginSettings::read(&written, Some("p9")).unwrap(),
            settings
        );
    }

    #[test]
    fn each_project_has_its_own_sign_in_or_shares_one() {
        let mut settings = PluginSettings::default();
        settings.save(
            "p1",
            values(&[("jira_site", "one"), ("jira_api_token", "t1")]),
        );
        settings.save("p2", values(&[("jira_site", "two")]));
        assert_eq!(settings.values(Some("p1"))["jira_site"], "one");
        assert_eq!(settings.values(Some("p2")), values(&[("jira_site", "two")]));
        assert_eq!(settings.sign_ins.len(), 2);
        // A blank value removes it, and a key left out keeps its value.
        settings.save("p1", values(&[("jira_site", "uno"), ("jira_email", " ")]));
        assert_eq!(
            settings.values(Some("p1")),
            values(&[("jira_site", "uno"), ("jira_api_token", "t1")])
        );
        // A third project uses the first project's sign-in.
        let first = settings.projects["p1"].clone();
        settings.link("p3", Some(&first)).unwrap();
        assert_eq!(settings.values(Some("p3"))["jira_site"], "uno");
        assert_eq!(settings.uses(&first), 2);
        assert!(settings.link("p3", Some("missing")).is_err());
        // Stopping p2's use forgets its sign-in, which nothing else uses.
        settings.link("p2", None).unwrap();
        assert!(settings.values(Some("p2")).is_empty());
        assert_eq!(settings.sign_ins.len(), 1);
        // A new sign-in never takes an id still in use.
        settings.save("p4", values(&[("jira_site", "four")]));
        assert_ne!(settings.projects["p4"], first);
        assert!(settings.values(None).is_empty());
    }
}
