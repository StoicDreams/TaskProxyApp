use crate::prelude::*;

pub(crate) fn get_hash_code(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let hash_result = hasher.finalize();
    let hash_result = general_purpose::STANDARD.encode(hash_result);
    URL_SAFE_NO_PAD.encode(hash_result)
}

pub(crate) fn newid() -> Uuid {
    Uuid::now_v7()
}

pub(crate) fn to_json<T: Serialize>(value: &T) -> Result<String, String> {
    let json = serde_json::ser::to_string_pretty(value).map_err(|err| format!("{}", err))?;
    Ok(json)
}

pub(crate) fn from_json<T: DeserializeOwned>(value: &str) -> Result<T, String> {
    let instance = serde_json::from_str(value).map_err(|err| format!("{}", err))?;
    Ok(instance)
}

pub(crate) fn parse_uuid(value: &str) -> Result<Uuid, String> {
    match Uuid::parse_str(value) {
        Ok(uuid) => Ok(uuid),
        Err(_) => Err(String::from("Invalid UUID")),
    }
}
