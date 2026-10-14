//! Persistent dashboard state – the single source of truth for kiosk and web UI.
//!
//! `state.json` = `{ "rev": u64, "state": AppStateData }` in the app config dir. Every change
//! goes through [`StateStore::apply_ops`]: validate, persist atomically, bump `rev`, notify the
//! kiosk (real secrets) and the SSE subscribers (redacted secrets).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use tauri::State;
use tokio::sync::{broadcast, Mutex};

/// Value sent instead of a stored secret over HTTP/SSE/export.
pub const SECRET_PLACEHOLDER: &str = "__gesetzt__";
pub const MAX_STATE_BYTES: usize = 2 * 1024 * 1024;
pub const ALLOWED_KEYS: [&str; 8] = [
    "version",
    "layout",
    "widgetSettings",
    "theme",
    "kiosk",
    "lagra",
    "planbar",
    "data",
];

const SECRET_SUFFIXES: [&str; 4] = ["apikey", "token", "password", "secret"];
const STATE_FILE: &str = "state.json";
const BACKUP_FILE: &str = "state.json.bak";
const TEMP_FILE: &str = "state.json.tmp";
const CORRUPT_FILE: &str = "state.json.corrupt";
const MAX_ORIGIN_LEN: usize = 64;
/// Segments of an op path – the real state is far flatter (`widgetSettings.<id>.sources.0.url`).
pub const MAX_PATH_SEGMENTS: usize = 16;
/// Nesting of the whole state. Serializing, redacting and dropping a `Value` recurse once per
/// level, and `serde_json::from_slice` refuses more than 128 levels when `state.json` is read
/// back – a deeper state would crash the server thread or be lost at the next start.
pub const MAX_STATE_DEPTH: usize = 64;
const EVENT_BUFFER: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum PathSeg {
    Index(usize),
    Key(String),
}

impl PathSeg {
    fn key(&self) -> String {
        match self {
            PathSeg::Index(i) => i.to_string(),
            PathSeg::Key(k) => k.clone(),
        }
    }

    /// Array index like JS: numbers and canonical numeric strings ("3", not "03" or "+3").
    fn index(&self) -> Option<usize> {
        match self {
            PathSeg::Index(i) => Some(*i),
            PathSeg::Key(k) => {
                let canonical = !k.is_empty()
                    && k.bytes().all(|b| b.is_ascii_digit())
                    && (k == "0" || !k.starts_with('0'));
                if canonical {
                    k.parse().ok()
                } else {
                    None
                }
            }
        }
    }
}

impl fmt::Display for PathSeg {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PathSeg::Index(i) => write!(f, "[{i}]"),
            PathSeg::Key(k) => write!(f, ".{k}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum StateOp {
    Set {
        path: Vec<PathSeg>,
        value: Value,
    },
    /// `create: false` (edits that may race a delete) is a no-op when the target is
    /// missing, instead of bringing it back as a partial entry.
    Merge {
        path: Vec<PathSeg>,
        value: Value,
        #[serde(default = "default_true", skip_serializing_if = "is_true")]
        create: bool,
    },
    Delete {
        path: Vec<PathSeg>,
    },
    Push {
        path: Vec<PathSeg>,
        value: Value,
    },
}

fn default_true() -> bool {
    true
}

fn is_true(value: &bool) -> bool {
    *value
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateError {
    /// Rejected ops or an invalid resulting state – the caller's fault.
    Invalid(String),
    /// Persisting failed – nothing was changed.
    Storage(String),
}

impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StateError::Invalid(msg) => f.write_str(msg),
            StateError::Storage(msg) => write!(f, "Zustand konnte nicht gespeichert werden: {msg}"),
        }
    }
}

impl std::error::Error for StateError {}

fn invalid(msg: impl Into<String>) -> StateError {
    StateError::Invalid(msg.into())
}

fn path_label(path: &[PathSeg]) -> String {
    if path.is_empty() {
        return "(Wurzel)".to_string();
    }
    let joined: String = path.iter().map(ToString::to_string).collect();
    joined.trim_start_matches('.').to_string()
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

pub fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SECRET_SUFFIXES.iter().any(|suffix| lower.ends_with(suffix))
}

fn is_empty_value(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        Value::Bool(_) | Value::Number(_) => false,
    }
}

fn redact_in_place(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if is_secret_key(key) {
                    if !is_empty_value(child) {
                        *child = Value::String(SECRET_PLACEHOLDER.to_string());
                    }
                } else {
                    redact_in_place(child);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_in_place),
        _ => {}
    }
}

/// Copy of `value` with every non-empty secret replaced by [`SECRET_PLACEHOLDER`].
pub fn redact(value: &Value) -> Value {
    let mut copy = value.clone();
    redact_in_place(&mut copy);
    copy
}

/// Absolute path of a value as strings (object keys, array indices).
type KeyPath = Vec<String>;

/// Replaces placeholders at secret keys in `incoming` (located at `path`) by the stored values
/// found at the same place in `current`. A placeholder without a stored counterpart becomes ""
/// – it must never be persisted, or the secret would look "set" forever. Secrets that arrive
/// with a real value are recorded in `fresh`.
fn restore_secrets_at(
    incoming: &mut Value,
    current: Option<&Value>,
    path: &mut KeyPath,
    fresh: &mut HashSet<KeyPath>,
) {
    match incoming {
        Value::Object(map) => {
            let current_map = current.and_then(Value::as_object);
            for (key, child) in map.iter_mut() {
                let stored = current_map.and_then(|m| m.get(key));
                path.push(key.clone());
                if is_secret_key(key) {
                    if child.as_str() == Some(SECRET_PLACEHOLDER) {
                        *child = stored
                            .cloned()
                            .unwrap_or_else(|| Value::String(String::new()));
                    } else {
                        fresh.insert(path.clone());
                    }
                } else {
                    restore_secrets_at(child, stored, path, fresh);
                }
                path.pop();
            }
        }
        Value::Array(items) => {
            let current_items = current.and_then(Value::as_array);
            for (i, child) in items.iter_mut().enumerate() {
                path.push(i.to_string());
                restore_secrets_at(child, current_items.and_then(|a| a.get(i)), path, fresh);
                path.pop();
            }
        }
        _ => {}
    }
}

fn restore_op_secrets(root: &Value, op: &mut StateOp, fresh: &mut HashSet<KeyPath>) {
    let key_path = |path: &[PathSeg]| -> KeyPath { path.iter().map(PathSeg::key).collect() };
    match op {
        StateOp::Set { path, value } => {
            let mut base = key_path(path);
            let target_is_secret = matches!(path.last(), Some(PathSeg::Key(k)) if is_secret_key(k));
            if target_is_secret && value.as_str() == Some(SECRET_PLACEHOLDER) {
                *value = get_at(root, path)
                    .cloned()
                    .unwrap_or_else(|| Value::String(String::new()));
            } else if target_is_secret {
                fresh.insert(base);
            } else {
                restore_secrets_at(value, get_at(root, path), &mut base, fresh);
            }
        }
        StateOp::Merge { path, value, .. } => {
            restore_secrets_at(value, get_at(root, path), &mut key_path(path), fresh)
        }
        StateOp::Push { path, value } => {
            let mut base = key_path(path);
            let next_index = get_at(root, path)
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            base.push(next_index.to_string());
            restore_secrets_at(value, None, &mut base, fresh);
        }
        StateOp::Delete { .. } => {}
    }
}

/// Keys that decide where a sibling secret is sent to (`url`, `baseUrl`, `host`, …).
fn is_endpoint_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.ends_with("url") || lower.ends_with("host")
}

/// A stored secret must not follow a new endpoint chosen over HTTP – otherwise anyone with
/// the PIN could point e.g. `lagra.url` at their own server and receive the token. When an
/// endpoint key changed and the secret next to it was not re-entered in the same request,
/// the secret is cleared.
fn clear_redirected_secrets(
    old: &Value,
    new: &mut Value,
    path: &mut KeyPath,
    fresh: &HashSet<KeyPath>,
) {
    match (old, new) {
        (Value::Object(old_map), Value::Object(new_map)) => {
            let endpoint_changed = new_map
                .iter()
                .any(|(k, v)| is_endpoint_key(k) && old_map.get(k) != Some(v))
                || old_map
                    .keys()
                    .any(|k| is_endpoint_key(k) && !new_map.contains_key(k));
            for (key, value) in new_map.iter_mut() {
                path.push(key.clone());
                if is_secret_key(key) {
                    let unchanged = old_map.get(key) == Some(&*value);
                    if endpoint_changed
                        && unchanged
                        && !is_empty_value(value)
                        && !fresh.contains(path)
                    {
                        log::warn!(
                            "Geheimnis bei {} zurückgesetzt: Adresse wurde geändert",
                            path.join(".")
                        );
                        *value = Value::String(String::new());
                    }
                } else if let Some(old_child) = old_map.get(key) {
                    clear_redirected_secrets(old_child, value, path, fresh);
                }
                path.pop();
            }
        }
        (Value::Array(old_items), Value::Array(new_items)) => {
            for (i, value) in new_items.iter_mut().enumerate() {
                if let Some(old_child) = old_items.get(i) {
                    path.push(i.to_string());
                    clear_redirected_secrets(old_child, value, path, fresh);
                    path.pop();
                }
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

fn child<'a>(value: &'a Value, seg: &PathSeg) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(&seg.key()),
        Value::Array(items) => seg.index().and_then(|i| items.get(i)),
        _ => None,
    }
}

pub fn get_at<'a>(root: &'a Value, path: &[PathSeg]) -> Option<&'a Value> {
    path.iter().try_fold(root, |cur, seg| child(cur, seg))
}

/// Walks `path` from `root`. With `create`, missing or `null` steps become `{}` (an array
/// accepts its next free index); without it, a missing step yields `Ok(None)`.
fn walk_mut<'a>(
    root: &'a mut Value,
    path: &[PathSeg],
    create: bool,
) -> Result<Option<&'a mut Value>, StateError> {
    let mut cur = root;
    for (depth, seg) in path.iter().enumerate() {
        let here = &path[..depth];
        cur = match cur {
            Value::Object(map) => {
                let key = seg.key();
                if create {
                    let slot = map.entry(key).or_insert(Value::Null);
                    if slot.is_null() {
                        *slot = Value::Object(Map::new());
                    }
                    slot
                } else {
                    match map.get_mut(&key) {
                        Some(next) => next,
                        None => return Ok(None),
                    }
                }
            }
            Value::Array(items) => {
                let Some(index) = seg.index() else {
                    if create {
                        return Err(invalid(format!(
                            "Ungültiger Pfad: {} ist eine Liste, «{}» ist kein Index",
                            path_label(here),
                            seg.key()
                        )));
                    }
                    return Ok(None);
                };
                if index == items.len() && create {
                    items.push(Value::Object(Map::new()));
                }
                match items.get_mut(index) {
                    Some(next) => {
                        if next.is_null() && create {
                            *next = Value::Object(Map::new());
                        }
                        next
                    }
                    None if create => {
                        return Err(invalid(format!(
                            "Ungültiger Pfad: Index {index} liegt ausserhalb von {}",
                            path_label(here)
                        )))
                    }
                    None => return Ok(None),
                }
            }
            _ if create => {
                return Err(invalid(format!(
                    "Ungültiger Pfad: {} ist weder Objekt noch Liste",
                    path_label(here)
                )))
            }
            _ => return Ok(None),
        };
    }
    Ok(Some(cur))
}

fn op_set(root: &mut Value, path: &[PathSeg], value: Value) -> Result<(), StateError> {
    let Some((last, parent_path)) = path.split_last() else {
        *root = value;
        return Ok(());
    };
    let parent = walk_mut(root, parent_path, true)?
        .ok_or_else(|| invalid(format!("Ungültiger Pfad: {}", path_label(path))))?;
    match parent {
        Value::Object(map) => {
            map.insert(last.key(), value);
            Ok(())
        }
        Value::Array(items) => {
            let index = last.index().ok_or_else(|| {
                invalid(format!(
                    "Ungültiger Pfad: {} ist eine Liste, «{}» ist kein Index",
                    path_label(parent_path),
                    last.key()
                ))
            })?;
            match index.cmp(&items.len()) {
                std::cmp::Ordering::Less => items[index] = value,
                std::cmp::Ordering::Equal => items.push(value),
                std::cmp::Ordering::Greater => {
                    return Err(invalid(format!(
                        "Ungültiger Pfad: Index {index} liegt ausserhalb von {}",
                        path_label(parent_path)
                    )))
                }
            }
            Ok(())
        }
        _ => Err(invalid(format!(
            "Ungültiger Pfad: {} ist weder Objekt noch Liste",
            path_label(parent_path)
        ))),
    }
}

fn op_merge(
    root: &mut Value,
    path: &[PathSeg],
    value: Value,
    create: bool,
) -> Result<(), StateError> {
    let Value::Object(patch) = value else {
        return Err(invalid(format!(
            "merge bei {} erwartet ein Objekt",
            path_label(path)
        )));
    };
    let target = match walk_mut(root, path, create)? {
        Some(target) => target,
        // Without `create` a missing (or mistyped) target leaves the state as it is.
        None if !create => return Ok(()),
        None => return Err(invalid(format!("Ungültiger Pfad: {}", path_label(path)))),
    };
    match target {
        Value::Object(map) => map.extend(patch),
        other => *other = Value::Object(patch),
    }
    Ok(())
}

fn op_delete(root: &mut Value, path: &[PathSeg]) -> Result<(), StateError> {
    let Some((last, parent_path)) = path.split_last() else {
        return Err(invalid("delete auf die Wurzel ist nicht erlaubt"));
    };
    match walk_mut(root, parent_path, false)? {
        Some(Value::Object(map)) => {
            map.remove(&last.key());
        }
        Some(Value::Array(items)) => {
            if let Some(index) = last.index().filter(|i| *i < items.len()) {
                items.remove(index);
            }
        }
        _ => {}
    }
    Ok(())
}

fn op_push(root: &mut Value, path: &[PathSeg], value: Value) -> Result<(), StateError> {
    if path.is_empty() {
        return Err(invalid("push auf die Wurzel ist nicht erlaubt"));
    }
    match get_at(root, path) {
        Some(Value::Array(_)) => {
            if let Some(Value::Array(items)) = walk_mut(root, path, false)? {
                items.push(value);
            }
            Ok(())
        }
        Some(Value::Null) | None => op_set(root, path, Value::Array(vec![value])),
        Some(_) => Err(invalid(format!(
            "push bei {} erwartet eine Liste",
            path_label(path)
        ))),
    }
}

pub fn apply_op(root: &mut Value, op: StateOp) -> Result<(), StateError> {
    match op {
        StateOp::Set { path, value } => op_set(root, &path, value),
        StateOp::Merge {
            path,
            value,
            create,
        } => op_merge(root, &path, value, create),
        StateOp::Delete { path } => op_delete(root, &path),
        StateOp::Push { path, value } => op_push(root, &path, value),
    }
}

/// Top-level shape check; deeper defaults are the frontend's job (`withDefaults()`).
pub fn validate_state(state: &Value) -> Result<(), StateError> {
    let Value::Object(map) = state else {
        return Err(invalid("Der Zustand muss ein Objekt sein"));
    };
    for (key, value) in map {
        match key.as_str() {
            "version" => {
                if !value.is_u64() {
                    return Err(invalid("«version» muss eine ganze Zahl sein"));
                }
            }
            k if ALLOWED_KEYS.contains(&k) => {
                if !value.is_object() {
                    return Err(invalid(format!("«{k}» muss ein Objekt sein")));
                }
            }
            other => {
                return Err(invalid(format!(
                    "Unbekannter Schlüssel im Zustand: «{other}»"
                )))
            }
        }
    }
    Ok(())
}

impl StateOp {
    fn path(&self) -> &[PathSeg] {
        match self {
            StateOp::Set { path, .. }
            | StateOp::Merge { path, .. }
            | StateOp::Delete { path }
            | StateOp::Push { path, .. } => path,
        }
    }
}

/// Nesting depth of objects/arrays (a scalar is 0), walked without recursion and stopping as
/// soon as `limit` is exceeded.
fn depth_exceeds(value: &Value, limit: usize) -> bool {
    let mut stack = vec![(value, 0usize)];
    while let Some((value, depth)) = stack.pop() {
        let children: Box<dyn Iterator<Item = &Value>> = match value {
            Value::Object(map) => Box::new(map.values()),
            Value::Array(items) => Box::new(items.iter()),
            _ => continue,
        };
        let depth = depth + 1;
        if depth > limit {
            return true;
        }
        stack.extend(children.map(|child| (child, depth)));
    }
    false
}

fn ensure_depth(state: &Value) -> Result<(), StateError> {
    if depth_exceeds(state, MAX_STATE_DEPTH) {
        return Err(invalid(format!(
            "Zustand zu tief verschachtelt (maximal {MAX_STATE_DEPTH} Ebenen)"
        )));
    }
    Ok(())
}

fn ensure_size(state: &Value) -> Result<(), StateError> {
    let size = serde_json::to_vec(state)
        .map_err(|e| invalid(format!("Zustand nicht serialisierbar: {e}")))?
        .len();
    if size > MAX_STATE_BYTES {
        return Err(invalid(format!(
            "Zustand zu gross ({} KB, maximal {} KB)",
            size / 1024,
            MAX_STATE_BYTES / 1024
        )));
    }
    Ok(())
}

/// Applies all ops to a copy of `state` – all or nothing.
pub fn apply_ops_to(state: &Value, ops: Vec<StateOp>, via_http: bool) -> Result<Value, StateError> {
    if let Some(op) = ops.iter().find(|op| op.path().len() > MAX_PATH_SEGMENTS) {
        return Err(invalid(format!(
            "Pfad zu lang: {} Ebenen (maximal {MAX_PATH_SEGMENTS})",
            op.path().len()
        )));
    }
    let mut next = state.clone();
    let mut fresh = HashSet::new();
    for mut op in ops {
        if via_http {
            restore_op_secrets(&next, &mut op, &mut fresh);
        }
        apply_op(&mut next, op)?;
    }
    // Before anything walks the new state recursively.
    ensure_depth(&next)?;
    if via_http {
        clear_redirected_secrets(state, &mut next, &mut Vec::new(), &fresh);
    }
    validate_state(&next)?;
    ensure_size(&next)?;
    Ok(next)
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct StateFileRef<'a> {
    rev: u64,
    state: &'a Value,
}

#[derive(Deserialize)]
struct StateFile {
    rev: u64,
    state: Value,
}

fn read_state_file(path: &Path) -> Result<Option<StateFile>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let mut file: StateFile = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let Value::Object(map) = &mut file.state else {
        return Err("«state» ist kein Objekt".to_string());
    };
    // Unknown or mistyped top-level keys are dropped instead of discarding the whole file.
    map.retain(|key, value| {
        let keep = match key.as_str() {
            "version" => value.is_u64(),
            k => ALLOWED_KEYS.contains(&k) && value.is_object(),
        };
        if !keep {
            log::warn!("state.json: ungültiger Schlüssel «{key}» wird verworfen");
        }
        keep
    });
    Ok(Some(file))
}

pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// tmp + fsync + rename; the previous `state.json` stays as `state.json.bak`. `state.json`
/// exists at every point, so a crash never leaves the kiosk without state.
fn persist(dir: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let target = dir.join(STATE_FILE);
    let temp = dir.join(TEMP_FILE);
    let backup = dir.join(BACKUP_FILE);

    write_private(&temp, bytes)?;
    if target.exists() {
        match fs::remove_file(&backup) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        if fs::hard_link(&target, &backup).is_err() {
            fs::copy(&target, &backup)?;
        }
    }
    fs::rename(&temp, &target)?;
    if let Ok(dir_handle) = fs::File::open(dir) {
        // Makes the rename durable; not every filesystem supports fsync on directories.
        let _ = dir_handle.sync_all();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub rev: u64,
    pub state: Value,
}

/// Broadcast to SSE clients: `{rev,state,origin}` with redacted secrets, serialized once.
#[derive(Debug, Clone)]
pub struct StateEvent {
    pub rev: u64,
    pub json: Arc<str>,
}

/// Passed to the change hook (kiosk event) – carries the real secrets.
pub struct StateChange<'a> {
    pub rev: u64,
    pub state: &'a Value,
    pub origin: &'a str,
}

type ChangeHook = Box<dyn Fn(StateChange<'_>) + Send + Sync>;

pub struct StateStore {
    dir: PathBuf,
    current: RwLock<Arc<Snapshot>>,
    /// Serializes appliers; held across the persist so events leave in `rev` order.
    writer: Mutex<()>,
    events: broadcast::Sender<StateEvent>,
    hook: OnceLock<ChangeHook>,
}

#[derive(Serialize)]
struct EventPayload<'a> {
    rev: u64,
    state: &'a Value,
    origin: &'a str,
}

/// `{rev,state,origin}` with secrets redacted – used for SSE.
pub fn redacted_event_json(rev: u64, state: &Value, origin: &str) -> String {
    let redacted = redact(state);
    serde_json::to_string(&EventPayload {
        rev,
        state: &redacted,
        origin,
    })
    .unwrap_or_else(|_| "{}".to_string())
}

impl StateStore {
    /// Loads `state.json` from `dir`. A broken file is kept as `state.json.corrupt` and the
    /// backup is used instead; without either the store starts empty (rev 0).
    pub fn load(dir: PathBuf) -> Self {
        let main = dir.join(STATE_FILE);
        let (rev, state) = match read_state_file(&main) {
            Ok(Some(file)) => (file.rev, file.state),
            Ok(None) => (0, Value::Object(Map::new())),
            Err(e) => {
                log::error!("state.json ist beschädigt ({e}) – versuche Sicherung");
                if let Err(e) = fs::rename(&main, dir.join(CORRUPT_FILE)) {
                    log::warn!("state.json konnte nicht beiseitegelegt werden: {e}");
                }
                match read_state_file(&dir.join(BACKUP_FILE)) {
                    // +1: the lost write may already have reached clients with that rev.
                    Ok(Some(file)) => (file.rev + 1, file.state),
                    Ok(None) => (0, Value::Object(Map::new())),
                    Err(e) => {
                        log::error!("state.json.bak ist ebenfalls unbrauchbar ({e}) – starte leer");
                        (0, Value::Object(Map::new()))
                    }
                }
            }
        };
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        StateStore {
            dir,
            current: RwLock::new(Arc::new(Snapshot { rev, state })),
            writer: Mutex::new(()),
            events,
            hook: OnceLock::new(),
        }
    }

    pub fn snapshot(&self) -> Arc<Snapshot> {
        match self.current.read() {
            Ok(guard) => Arc::clone(&guard),
            Err(poisoned) => Arc::clone(&poisoned.into_inner()),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<StateEvent> {
        self.events.subscribe()
    }

    /// Registers the kiosk notification (Tauri event). Only the first call has an effect.
    pub fn set_change_hook(&self, hook: impl Fn(StateChange<'_>) + Send + Sync + 'static) {
        if self.hook.set(Box::new(hook)).is_err() {
            log::warn!("StateStore: Änderungs-Hook ist bereits gesetzt");
        }
    }

    /// The single mutation entry point for Tauri commands and HTTP. `via_http` restores
    /// placeholder secrets from the stored state before applying.
    pub async fn apply_ops(
        &self,
        ops: Vec<StateOp>,
        origin: &str,
        via_http: bool,
    ) -> Result<u64, StateError> {
        let _writer = self.writer.lock().await;
        let current = self.snapshot();
        if ops.is_empty() {
            return Ok(current.rev);
        }
        let next_state = apply_ops_to(&current.state, ops, via_http)?;
        let next_rev = current.rev + 1;

        let bytes = serde_json::to_vec_pretty(&StateFileRef {
            rev: next_rev,
            state: &next_state,
        })
        .map_err(|e| StateError::Storage(e.to_string()))?;
        let dir = self.dir.clone();
        tokio::task::spawn_blocking(move || persist(&dir, &bytes))
            .await
            .map_err(|e| StateError::Storage(e.to_string()))?
            .map_err(|e| StateError::Storage(e.to_string()))?;

        let snapshot = Arc::new(Snapshot {
            rev: next_rev,
            state: next_state,
        });
        match self.current.write() {
            Ok(mut guard) => *guard = Arc::clone(&snapshot),
            Err(poisoned) => *poisoned.into_inner() = Arc::clone(&snapshot),
        }

        let origin: String = origin.chars().take(MAX_ORIGIN_LEN).collect();
        if let Some(hook) = self.hook.get() {
            hook(StateChange {
                rev: next_rev,
                state: &snapshot.state,
                origin: &origin,
            });
        }
        // No receivers is the normal case without open web UIs.
        let _ = self.events.send(StateEvent {
            rev: next_rev,
            json: redacted_event_json(next_rev, &snapshot.state, &origin).into(),
        });
        Ok(next_rev)
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct StateGetResult {
    rev: u64,
    state: Value,
}

#[derive(Serialize)]
pub struct StateApplyResult {
    rev: u64,
}

#[tauri::command]
pub async fn state_get(store: State<'_, Arc<StateStore>>) -> Result<StateGetResult, String> {
    let snapshot = store.snapshot();
    Ok(StateGetResult {
        rev: snapshot.rev,
        state: snapshot.state.clone(),
    })
}

#[tauri::command]
pub async fn state_apply(
    ops: Vec<StateOp>,
    origin: String,
    store: State<'_, Arc<StateStore>>,
) -> Result<StateApplyResult, String> {
    let rev = store
        .apply_ops(ops, &origin, false)
        .await
        .map_err(|e| e.to_string())?;
    Ok(StateApplyResult { rev })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    /// Unique scratch directory below the system temp dir, removed on drop.
    pub(crate) struct TestDir(pub PathBuf);

    impl TestDir {
        pub(crate) fn new(tag: &str) -> Self {
            let name = format!(
                "slatedesk-test-{tag}-{}",
                hex::encode(rand::random::<[u8; 8]>())
            );
            let dir = std::env::temp_dir().join(name);
            fs::create_dir_all(&dir).expect("create test dir");
            TestDir(dir)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn ops(value: Value) -> Vec<StateOp> {
        serde_json::from_value(value).expect("valid ops")
    }

    fn apply(state: Value, op_list: Value) -> Result<Value, StateError> {
        apply_ops_to(&state, ops(op_list), false)
    }

    /// `{ "a": { "a": … 1 } }` with `levels` objects.
    fn nested(levels: usize) -> Value {
        (0..levels).fold(json!(1), |inner, _| json!({ "a": inner }))
    }

    #[test]
    fn deep_paths_and_values_are_rejected() {
        let mut long_path = vec![json!("widgetSettings")];
        long_path.extend(std::iter::repeat_n(json!("a"), 20_000));
        let err = apply(
            json!({}),
            json!([{ "op": "set", "path": long_path, "value": 1 }]),
        )
        .unwrap_err();
        assert!(matches!(err, StateError::Invalid(ref m) if m.starts_with("Pfad zu lang")));

        let mut ok_path = vec![json!("widgetSettings")];
        ok_path.extend(std::iter::repeat_n(json!("a"), MAX_PATH_SEGMENTS - 1));
        assert!(apply(
            json!({}),
            json!([{ "op": "set", "path": ok_path, "value": 1 }])
        )
        .is_ok());

        // A short path with a deep value is checked on the resulting state.
        let deep = apply(
            json!({}),
            json!([{ "op": "set", "path": ["data", "x"], "value": nested(MAX_STATE_DEPTH) }]),
        )
        .unwrap_err();
        assert!(matches!(deep, StateError::Invalid(ref m) if m.contains("verschachtelt")));
        let fits = apply(
            json!({}),
            json!([{ "op": "set", "path": ["data", "x"], "value": nested(MAX_STATE_DEPTH - 2) }]),
        );
        assert!(fits.is_ok());

        assert!(!depth_exceeds(&json!(1), 0));
        assert!(depth_exceeds(&json!([[]]), 1));
        assert!(!depth_exceeds(&json!([[]]), 2));
    }

    #[tokio::test]
    async fn deepest_allowed_state_survives_a_restart() {
        let dir = TestDir::new("deep");
        let store = StateStore::load(dir.0.clone());
        let value = nested(MAX_STATE_DEPTH - 2);
        store
            .apply_ops(
                vec![StateOp::Set {
                    path: vec![PathSeg::Key("data".into()), PathSeg::Key("x".into())],
                    value: value.clone(),
                }],
                "remote",
                true,
            )
            .await
            .unwrap();
        let reloaded = StateStore::load(dir.0.clone());
        assert_eq!(reloaded.snapshot().rev, 1);
        assert_eq!(reloaded.snapshot().state["data"]["x"], value);
    }

    #[test]
    fn op_json_shape_matches_contract() {
        let parsed = ops(json!([
            { "op": "set", "path": ["layout", "widgets", 0, "x"], "value": 3 },
            { "op": "merge", "path": ["theme"], "value": { "mode": "dark" } },
            { "op": "delete", "path": ["data", "todos", "a1"] },
            { "op": "push", "path": ["layout", "widgets"], "value": {} }
        ]));
        assert_eq!(
            parsed[0],
            StateOp::Set {
                path: vec![
                    PathSeg::Key("layout".into()),
                    PathSeg::Key("widgets".into()),
                    PathSeg::Index(0),
                    PathSeg::Key("x".into())
                ],
                value: json!(3)
            }
        );
        assert!(
            serde_json::from_value::<Vec<StateOp>>(json!([{ "op": "set", "path": [] }])).is_err()
        );
        assert!(
            serde_json::from_value::<Vec<StateOp>>(json!([{ "op": "nope", "path": [] }])).is_err()
        );
    }

    #[test]
    fn set_creates_intermediate_objects() {
        let next = apply(
            json!({}),
            json!([{ "op": "set", "path": ["widgetSettings", "w1", "city"], "value": "Bern" }]),
        )
        .unwrap();
        assert_eq!(
            next,
            json!({ "widgetSettings": { "w1": { "city": "Bern" } } })
        );
        let next = apply(
            json!({ "kiosk": { "displaySchedule": null } }),
            json!([{ "op": "set", "path": ["kiosk", "displaySchedule", "on"], "value": "07:00" }]),
        )
        .unwrap();
        assert_eq!(
            next,
            json!({ "kiosk": { "displaySchedule": { "on": "07:00" } } })
        );
    }

    #[test]
    fn set_on_arrays_replaces_appends_and_rejects_gaps() {
        let base = json!({ "layout": { "widgets": [{ "x": 0 }, { "x": 1 }] } });
        let next = apply(
            base.clone(),
            json!([{ "op": "set", "path": ["layout", "widgets", 1, "x"], "value": 5 }]),
        )
        .unwrap();
        assert_eq!(next["layout"]["widgets"][1]["x"], json!(5));
        let next = apply(
            base.clone(),
            json!([{ "op": "set", "path": ["layout", "widgets", "2"], "value": { "x": 2 } }]),
        )
        .unwrap();
        assert_eq!(next["layout"]["widgets"].as_array().unwrap().len(), 3);
        assert!(apply(
            base.clone(),
            json!([{ "op": "set", "path": ["layout", "widgets", 5], "value": 1 }])
        )
        .is_err());
        assert!(apply(
            base,
            json!([{ "op": "set", "path": ["layout", "widgets", "x"], "value": 1 }])
        )
        .is_err());
    }

    #[test]
    fn set_rejects_descending_into_primitives() {
        let err = apply(
            json!({ "kiosk": { "name": "A" } }),
            json!([{ "op": "set", "path": ["kiosk", "name", "x"], "value": 1 }]),
        )
        .unwrap_err();
        assert!(matches!(err, StateError::Invalid(_)));
    }

    #[test]
    fn set_root_replaces_and_validates() {
        let next = apply(
            json!({ "theme": { "mode": "dark" } }),
            json!([{ "op": "set", "path": [], "value": { "kiosk": { "name": "X" } } }]),
        )
        .unwrap();
        assert_eq!(next, json!({ "kiosk": { "name": "X" } }));
        assert!(apply(
            json!({}),
            json!([{ "op": "set", "path": [], "value": { "evil": {} } }])
        )
        .is_err());
        assert!(apply(
            json!({}),
            json!([{ "op": "set", "path": [], "value": [1, 2] }])
        )
        .is_err());
    }

    #[test]
    fn merge_is_shallow_and_creates_target() {
        let base = json!({ "theme": { "mode": "dark", "accent": { "a": 1 } } });
        let next = apply(
            base,
            json!([{ "op": "merge", "path": ["theme"], "value": { "accent": { "b": 2 } } }]),
        )
        .unwrap();
        assert_eq!(
            next,
            json!({ "theme": { "mode": "dark", "accent": { "b": 2 } } })
        );
        let next = apply(
            json!({}),
            json!([{ "op": "merge", "path": ["widgetSettings", "w9"], "value": { "a": 1 } }]),
        )
        .unwrap();
        assert_eq!(next, json!({ "widgetSettings": { "w9": { "a": 1 } } }));
        let next = apply(
            json!({ "widgetSettings": { "w": 3 } }),
            json!([{ "op": "merge", "path": ["widgetSettings", "w"], "value": { "a": 1 } }]),
        )
        .unwrap();
        assert_eq!(next, json!({ "widgetSettings": { "w": { "a": 1 } } }));
        let next = apply(
            json!({ "theme": {} }),
            json!([{ "op": "merge", "path": [], "value": { "kiosk": { "name": "K" } } }]),
        )
        .unwrap();
        assert_eq!(next, json!({ "theme": {}, "kiosk": { "name": "K" } }));
        assert!(apply(
            json!({}),
            json!([{ "op": "merge", "path": ["theme"], "value": 3 }])
        )
        .is_err());
    }

    #[test]
    fn delete_removes_keys_and_indices_and_ignores_missing() {
        let base = json!({ "data": { "todos": { "a": {}, "b": {} } }, "layout": { "widgets": [1, 2, 3] } });
        let next = apply(
            base.clone(),
            json!([
                { "op": "delete", "path": ["data", "todos", "a"] },
                { "op": "delete", "path": ["layout", "widgets", 1] },
                { "op": "delete", "path": ["data", "announcements", "zz"] },
                { "op": "delete", "path": ["layout", "widgets", 9] },
                { "op": "delete", "path": ["kiosk", "x", "y"] }
            ]),
        )
        .unwrap();
        assert_eq!(
            next,
            json!({ "data": { "todos": { "b": {} } }, "layout": { "widgets": [1, 3] } })
        );
        assert!(apply(base, json!([{ "op": "delete", "path": [] }])).is_err());
    }

    #[test]
    fn push_appends_or_creates() {
        let next = apply(
            json!({}),
            json!([{ "op": "push", "path": ["layout", "widgets"], "value": { "i": 1 } }]),
        )
        .unwrap();
        assert_eq!(next, json!({ "layout": { "widgets": [{ "i": 1 }] } }));
        let next = apply(
            next,
            json!([{ "op": "push", "path": ["layout", "widgets"], "value": { "i": 2 } }]),
        )
        .unwrap();
        assert_eq!(next["layout"]["widgets"].as_array().unwrap().len(), 2);
        assert!(apply(
            json!({ "layout": { "widgets": {} } }),
            json!([{ "op": "push", "path": ["layout", "widgets"], "value": 1 }])
        )
        .is_err());
        assert!(apply(json!({}), json!([{ "op": "push", "path": [], "value": 1 }])).is_err());
    }

    #[test]
    fn batch_is_all_or_nothing() {
        let base = json!({ "theme": { "mode": "dark" } });
        let result = apply(
            base,
            json!([
                { "op": "set", "path": ["theme", "mode"], "value": "light" },
                { "op": "set", "path": ["theme", "mode", "x"], "value": 1 }
            ]),
        );
        assert!(result.is_err());
    }

    #[test]
    fn validation_rejects_unknown_and_mistyped_keys() {
        assert!(validate_state(&json!({ "version": 1, "layout": {}, "data": {} })).is_ok());
        assert!(validate_state(&json!({ "foo": 1 })).is_err());
        assert!(validate_state(&json!({ "layout": [] })).is_err());
        assert!(validate_state(&json!({ "version": "1" })).is_err());
        assert!(apply(
            json!({}),
            json!([{ "op": "set", "path": ["hack"], "value": {} }])
        )
        .is_err());
        assert!(apply(
            json!({ "theme": {} }),
            json!([{ "op": "set", "path": ["theme"], "value": null }])
        )
        .is_err());
    }

    #[test]
    fn size_limit_is_enforced() {
        let big = "x".repeat(MAX_STATE_BYTES);
        let err = apply(
            json!({}),
            json!([{ "op": "set", "path": ["kiosk", "name"], "value": big }]),
        )
        .unwrap_err();
        assert!(err.to_string().contains("zu gross"));
    }

    #[test]
    fn secret_keys_are_detected_by_suffix() {
        for key in [
            "apiKey",
            "openaiApiKey",
            "token",
            "lagraToken",
            "password",
            "clientSecret",
            "SECRET",
        ] {
            assert!(is_secret_key(key), "{key}");
        }
        for key in ["maxTokens", "tokens", "keyboard", "secretary", "name"] {
            assert!(!is_secret_key(key), "{key}");
        }
    }

    #[test]
    fn redact_replaces_non_empty_secrets_at_any_depth() {
        let state = json!({
            "lagra": { "url": "https://x", "token": "abc", "enabled": true },
            "widgetSettings": {
                "w1": { "apiKey": "", "maxTokens": 300 },
                "w2": { "feeds": [{ "url": "u", "password": "pw" }], "secret": null }
            }
        });
        let redacted = redact(&state);
        assert_eq!(redacted["lagra"]["token"], json!(SECRET_PLACEHOLDER));
        assert_eq!(redacted["lagra"]["url"], json!("https://x"));
        assert_eq!(redacted["widgetSettings"]["w1"]["apiKey"], json!(""));
        assert_eq!(redacted["widgetSettings"]["w1"]["maxTokens"], json!(300));
        assert_eq!(
            redacted["widgetSettings"]["w2"]["feeds"][0]["password"],
            json!(SECRET_PLACEHOLDER)
        );
        assert_eq!(redacted["widgetSettings"]["w2"]["secret"], Value::Null);
        assert_eq!(state["lagra"]["token"], json!("abc"));
    }

    #[test]
    fn restore_keeps_untouched_secrets_over_http() {
        let stored = json!({
            "lagra": { "url": "https://x", "token": "real" },
            "widgetSettings": { "w1": { "apiKey": "k1", "city": "Bern" } }
        });
        let incoming = ops(json!([
            { "op": "merge", "path": ["lagra"], "value": { "enabled": true, "token": SECRET_PLACEHOLDER } },
            { "op": "set", "path": ["widgetSettings", "w1"], "value": { "apiKey": SECRET_PLACEHOLDER, "city": "Thun" } },
            { "op": "set", "path": ["widgetSettings", "w2", "apiKey"], "value": SECRET_PLACEHOLDER }
        ]));
        let next = apply_ops_to(&stored, incoming, true).unwrap();
        assert_eq!(
            next["lagra"],
            json!({ "url": "https://x", "token": "real", "enabled": true })
        );
        assert_eq!(
            next["widgetSettings"]["w1"],
            json!({ "apiKey": "k1", "city": "Thun" })
        );
        assert_eq!(next["widgetSettings"]["w2"]["apiKey"], json!(""));

        let direct =
            ops(json!([{ "op": "set", "path": ["lagra", "token"], "value": SECRET_PLACEHOLDER }]));
        assert_eq!(apply_ops_to(&stored, direct, true).unwrap(), stored);

        let changed = ops(json!([{ "op": "set", "path": ["lagra", "token"], "value": "neu" }]));
        assert_eq!(
            apply_ops_to(&stored, changed, true).unwrap()["lagra"]["token"],
            json!("neu")
        );
    }

    #[test]
    fn changed_endpoint_drops_secret_unless_reentered() {
        let stored = json!({
            "lagra": { "url": "https://lagra.example.ch", "token": "real", "enabled": true },
            "widgetSettings": { "ai": { "localBaseUrl": "http://localhost:11434/v1", "apiKey": "sk" } }
        });
        let redirect = ops(
            json!([{ "op": "set", "path": ["lagra", "url"], "value": "https://evil.example" }]),
        );
        let next = apply_ops_to(&stored, redirect, true).unwrap();
        assert_eq!(next["lagra"]["token"], json!(""));

        let with_placeholder = ops(
            json!([{ "op": "merge", "path": ["lagra"], "value": { "url": "https://evil.example", "token": SECRET_PLACEHOLDER } }]),
        );
        assert_eq!(
            apply_ops_to(&stored, with_placeholder, true).unwrap()["lagra"]["token"],
            json!("")
        );

        let reentered = ops(json!([
            { "op": "set", "path": ["lagra", "url"], "value": "https://neu.example.ch" },
            { "op": "set", "path": ["lagra", "token"], "value": "real" }
        ]));
        assert_eq!(
            apply_ops_to(&stored, reentered, true).unwrap()["lagra"]["token"],
            json!("real")
        );

        let unrelated = ops(json!([{ "op": "set", "path": ["lagra", "enabled"], "value": false }]));
        assert_eq!(
            apply_ops_to(&stored, unrelated, true).unwrap()["lagra"]["token"],
            json!("real")
        );

        let nested = ops(
            json!([{ "op": "merge", "path": ["widgetSettings", "ai"], "value": { "localBaseUrl": "http://x:1234/v1" } }]),
        );
        assert_eq!(
            apply_ops_to(&stored, nested, true).unwrap()["widgetSettings"]["ai"]["apiKey"],
            json!("")
        );

        let kiosk = ops(
            json!([{ "op": "set", "path": ["lagra", "url"], "value": "https://neu.example.ch" }]),
        );
        assert_eq!(
            apply_ops_to(&stored, kiosk, false).unwrap()["lagra"]["token"],
            json!("real")
        );
    }

    #[test]
    fn planbar_section_keeps_its_api_key_secret() {
        let stored = apply(
            json!({}),
            json!([{ "op": "set", "path": ["planbar"], "value": { "enabled": true, "url": "https://planbar.dev", "apiKey": "pk_live_x" } }]),
        )
        .unwrap();
        assert!(validate_state(&stored).is_ok());
        assert_eq!(
            redact(&stored)["planbar"]["apiKey"],
            json!(SECRET_PLACEHOLDER)
        );
        assert!(apply(
            json!({}),
            json!([{ "op": "set", "path": ["planbar"], "value": "an" }])
        )
        .is_err());

        let untouched = ops(
            json!([{ "op": "merge", "path": ["planbar"], "value": { "enabled": false, "apiKey": SECRET_PLACEHOLDER } }]),
        );
        assert_eq!(
            apply_ops_to(&stored, untouched, true).unwrap()["planbar"]["apiKey"],
            json!("pk_live_x")
        );
        let redirect = ops(
            json!([{ "op": "set", "path": ["planbar", "url"], "value": "https://evil.example" }]),
        );
        assert_eq!(
            apply_ops_to(&stored, redirect, true).unwrap()["planbar"]["apiKey"],
            json!("")
        );
    }

    #[test]
    fn restore_handles_full_import() {
        let stored = json!({ "lagra": { "token": "real" }, "widgetSettings": { "w": { "list": [{ "apiKey": "a0" }] } } });
        let exported = redact(&stored);
        let import = vec![StateOp::Set {
            path: vec![],
            value: exported,
        }];
        assert_eq!(apply_ops_to(&stored, import, true).unwrap(), stored);
    }

    #[test]
    fn kiosk_ops_store_placeholders_verbatim() {
        let stored = json!({ "lagra": { "token": "real" } });
        let incoming =
            ops(json!([{ "op": "set", "path": ["lagra", "token"], "value": SECRET_PLACEHOLDER }]));
        let next = apply_ops_to(&stored, incoming, false).unwrap();
        assert_eq!(next["lagra"]["token"], json!(SECRET_PLACEHOLDER));
    }

    #[tokio::test]
    async fn apply_bumps_rev_persists_and_notifies() {
        let dir = TestDir::new("state");
        let store = StateStore::load(dir.0.clone());
        assert_eq!(store.snapshot().rev, 0);

        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_hook = Arc::clone(&seen);
        store.set_change_hook(move |change| {
            seen_hook.lock().unwrap().push((
                change.rev,
                change.state.clone(),
                change.origin.to_string(),
            ));
        });
        let mut rx = store.subscribe();

        let rev = store
            .apply_ops(ops(json!([{ "op": "set", "path": ["lagra"], "value": { "token": "t0", "url": "u" } }])), "kiosk", false)
            .await
            .unwrap();
        assert_eq!(rev, 1);
        let rev = store
            .apply_ops(
                ops(json!([{ "op": "set", "path": ["kiosk", "name"], "value": "Empfang" }])),
                "remote",
                true,
            )
            .await
            .unwrap();
        assert_eq!(rev, 2);
        assert_eq!(store.apply_ops(vec![], "kiosk", false).await.unwrap(), 2);

        let err = store
            .apply_ops(
                ops(json!([{ "op": "set", "path": ["nope"], "value": {} }])),
                "remote",
                true,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, StateError::Invalid(_)));
        assert_eq!(store.snapshot().rev, 2);

        {
            let seen = seen.lock().unwrap();
            assert_eq!(seen.len(), 2);
            assert_eq!(seen[0].1["lagra"]["token"], json!("t0"));
            assert_eq!(seen[1].2, "remote");
        }

        let first = rx.recv().await.unwrap();
        assert_eq!(first.rev, 1);
        let payload: Value = serde_json::from_str(&first.json).unwrap();
        assert_eq!(
            payload["state"]["lagra"]["token"],
            json!(SECRET_PLACEHOLDER)
        );
        assert_eq!(payload["origin"], json!("kiosk"));
        assert_eq!(rx.recv().await.unwrap().rev, 2);

        let reloaded = StateStore::load(dir.0.clone());
        let snap = reloaded.snapshot();
        assert_eq!(snap.rev, 2);
        assert_eq!(snap.state["kiosk"]["name"], json!("Empfang"));
        assert_eq!(snap.state["lagra"]["token"], json!("t0"));

        let backup: Value =
            serde_json::from_slice(&fs::read(dir.0.join(BACKUP_FILE)).unwrap()).unwrap();
        assert_eq!(backup["rev"], json!(1));
        let mode = fs::metadata(dir.0.join(STATE_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[tokio::test]
    async fn corrupt_state_falls_back_to_backup() {
        let dir = TestDir::new("corrupt");
        let store = StateStore::load(dir.0.clone());
        for name in ["A", "B"] {
            store
                .apply_ops(
                    ops(json!([{ "op": "set", "path": ["kiosk", "name"], "value": name }])),
                    "kiosk",
                    false,
                )
                .await
                .unwrap();
        }
        fs::write(dir.0.join(STATE_FILE), b"{ kaputt").unwrap();

        let recovered = StateStore::load(dir.0.clone());
        let snap = recovered.snapshot();
        assert_eq!(snap.state["kiosk"]["name"], json!("A"));
        assert_eq!(snap.rev, 2);
        assert!(dir.0.join(CORRUPT_FILE).exists());
    }

    #[test]
    fn load_drops_unknown_top_level_keys() {
        let dir = TestDir::new("sanitize");
        fs::write(
            dir.0.join(STATE_FILE),
            serde_json::to_vec(&json!({ "rev": 7, "state": { "kiosk": { "name": "K" }, "alt": 1, "layout": null } })).unwrap(),
        )
        .unwrap();
        let snap = StateStore::load(dir.0.clone()).snapshot();
        assert_eq!(snap.rev, 7);
        assert_eq!(snap.state, json!({ "kiosk": { "name": "K" } }));
    }

    #[test]
    fn missing_dir_starts_empty() {
        let dir = TestDir::new("empty");
        let snap = StateStore::load(dir.0.join("gibt-es-nicht")).snapshot();
        assert_eq!(snap.rev, 0);
        assert_eq!(snap.state, json!({}));
    }

    /// Same cases as `src/state/ops.conformance.test.ts`: the kiosk and the web UI apply ops
    /// optimistically, so both implementations must produce identical results.
    #[test]
    fn ops_conform_with_the_frontend() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../src/state/ops.conformance.json"))
                .expect("valid conformance fixture");
        let cases = fixture["cases"].as_array().expect("cases");
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"].as_str().unwrap_or("?");
            // Ops the frontend can't express (e.g. a fractional path segment) fail parsing here.
            let result = serde_json::from_value::<Vec<StateOp>>(case["ops"].clone())
                .map_err(|e| invalid(e.to_string()))
                .and_then(|ops| apply_ops_to(&case["state"], ops, false));
            if case["error"].as_bool() == Some(true) {
                assert!(result.is_err(), "{name}: expected an error, got {result:?}");
            } else {
                assert_eq!(
                    result.as_ref().ok(),
                    Some(&case["expect"]),
                    "{name}: {result:?}"
                );
            }
        }
    }
}
