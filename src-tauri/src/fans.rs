//! Fans over hwmon (`/sys/class/hwmon`): speed (RPM) and, where the chip has PWM outputs,
//! control from the web UI. Writing needs the udev rule of scripts/setup.sh, which makes
//! `pwmN` and `pwmN_enable` writable for the kiosk account; without it fans are read-only.
//!
//! Per fan: automatic (the chip or BIOS regulates, as without SlateDesk), a fixed speed, or a
//! curve over the CPU temperature. Safety first – this is the cooling:
//! - never below [`MIN_PERCENT`]; from [`GUARD_TEMP_C`] on every controlled fan runs at 100 %,
//!   and a curve without CPU temperature runs at 100 % too
//! - before SlateDesk takes a fan over, the chip's own mode is noted in the runtime directory
//!   (gone after a reboot, when the chips start in their own mode anyway). The app gives every
//!   fan back when it exits; after a crash `scripts/fans-restore.sh` does (ExecStopPost of
//!   slatedesk.service)

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

pub const MIN_PERCENT: u8 = 20;
pub const GUARD_TEMP_C: f64 = 85.0;
/// Lowest and highest temperature a curve may name.
const CURVE_TEMP_RANGE: (u8, u8) = (30, 84);
const CONTROL_EVERY: Duration = Duration::from_secs(2);
const MAX_CHANNELS: u32 = 16;
const SETTINGS_FILE: &str = "fans.json";
/// In `$XDG_RUNTIME_DIR`, read by scripts/fans-restore.sh.
pub const RESTORE_FILE: &str = "slatedesk-fans";
/// `pwmN_enable` value for manual control (the same in every hwmon driver).
const MANUAL: &str = "1";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_trim(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Opening for writing changes nothing in sysfs – it only tells whether a write would be allowed.
fn writable(path: &Path) -> bool {
    fs::OpenOptions::new().write(true).open(path).is_ok()
}

fn write_value(path: &Path, value: &str) -> Result<(), String> {
    fs::write(path, value).map_err(|e| format!("{}: {e}", path.display()))
}

const fn duty(percent: u8) -> u16 {
    (percent as u16 * 255 + 50) / 100
}

fn percent_of(duty: u16) -> u8 {
    ((u32::from(duty.min(255)) * 100 + 127) / 255) as u8
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FanSetting {
    /// The chip or BIOS regulates – SlateDesk does not touch the fan.
    Auto,
    Fixed {
        percent: u8,
    },
    /// `min_percent` up to `min_temp`, rising linearly to 100 % at `max_temp`.
    Curve {
        min_temp: u8,
        max_temp: u8,
        min_percent: u8,
    },
}

impl FanSetting {
    pub fn validate(self) -> Result<Self, String> {
        let percent_ok = |p: u8| (MIN_PERCENT..=100).contains(&p);
        match self {
            FanSetting::Auto => Ok(self),
            FanSetting::Fixed { percent } if percent_ok(percent) => Ok(self),
            FanSetting::Fixed { .. } => {
                Err(format!("Drehzahl zwischen {MIN_PERCENT} und 100 % wählen"))
            }
            FanSetting::Curve {
                min_temp,
                max_temp,
                min_percent,
            } => {
                let (low, high) = CURVE_TEMP_RANGE;
                if !percent_ok(min_percent) {
                    Err(format!(
                        "Mindestdrehzahl zwischen {MIN_PERCENT} und 100 % wählen"
                    ))
                } else if min_temp < low || max_temp > high || min_temp >= max_temp {
                    Err(format!(
                        "Temperaturen zwischen {low} und {high} °C wählen, die erste tiefer als die zweite"
                    ))
                } else {
                    Ok(self)
                }
            }
        }
    }

    /// Duty in percent at `temp` (CPU, °C), before the temperature guard; `None` = automatic.
    fn target(self, temp: Option<f64>) -> Option<u8> {
        match self {
            FanSetting::Auto => None,
            FanSetting::Fixed { percent } => Some(percent),
            FanSetting::Curve {
                min_temp,
                max_temp,
                min_percent,
            } => {
                let Some(temp) = temp else { return Some(100) };
                let (low, high) = (f64::from(min_temp), f64::from(max_temp));
                let share = ((temp - low) / (high - low)).clamp(0.0, 1.0);
                let percent = f64::from(min_percent) + share * f64::from(100 - min_percent);
                Some(percent.round() as u8)
            }
        }
        .map(|p| p.clamp(MIN_PERCENT, 100))
    }
}

#[derive(Default, Serialize, Deserialize)]
struct SettingsFile {
    #[serde(default)]
    fans: BTreeMap<String, FanSetting>,
}

// ---------------------------------------------------------------------------
// hwmon
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Channel {
    /// Chip name, its device and the channel number – stable across reboots, unlike hwmonN.
    id: String,
    name: String,
    chip: String,
    rpm: Option<PathBuf>,
    pwm: Option<PathBuf>,
    enable: Option<PathBuf>,
}

impl Channel {
    fn rpm(&self) -> Option<u32> {
        read_trim(self.rpm.as_deref()?)?.parse().ok()
    }

    fn percent(&self) -> Option<u8> {
        Some(percent_of(read_trim(self.pwm.as_deref()?)?.parse().ok()?))
    }

    fn outputs(&self) -> Option<(&Path, &Path)> {
        Some((self.pwm.as_deref()?, self.enable.as_deref()?))
    }

    fn controllable(&self) -> bool {
        self.outputs()
            .is_some_and(|(pwm, enable)| writable(pwm) && writable(enable))
    }
}

fn sanitize_id(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Fans and PWM outputs of every hwmon chip; attributes sit in the hwmon directory or, with
/// older drivers, in its `device`.
fn scan(root: &Path) -> Vec<Channel> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    dirs.sort();
    let mut channels = Vec::new();
    for dir in dirs {
        let Some(chip) = read_trim(&dir.join("name")) else {
            continue;
        };
        let device = fs::read_link(dir.join("device"))
            .ok()
            .and_then(|link| link.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_default();
        let find = |file: &str| {
            [dir.join(file), dir.join("device").join(file)]
                .into_iter()
                .find(|path| path.exists())
        };
        for n in 1..=MAX_CHANNELS {
            let rpm = find(&format!("fan{n}_input"));
            let pwm = find(&format!("pwm{n}"));
            if rpm.is_none() && pwm.is_none() {
                continue;
            }
            let enable = pwm.as_ref().and(find(&format!("pwm{n}_enable")));
            let name = find(&format!("fan{n}_label"))
                .and_then(|label| read_trim(&label))
                .unwrap_or_else(|| format!("Lüfter {n}"));
            channels.push(Channel {
                id: sanitize_id(&format!("{chip}-{device}-{n}")),
                name,
                chip: chip.clone(),
                rpm,
                pwm,
                enable,
            });
        }
    }
    channels
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/// Chip state before SlateDesk took a fan over.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Original {
    enable_path: PathBuf,
    enable: String,
    pwm_path: PathBuf,
    pwm: String,
}

#[derive(Default)]
struct FanState {
    settings: BTreeMap<String, FanSetting>,
    original: BTreeMap<String, Original>,
    /// Held at 100 % by the temperature guard right now.
    guarded: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FanInfo {
    pub id: String,
    pub name: String,
    pub chip: String,
    pub rpm: Option<u32>,
    /// Current PWM duty; `None` without PWM output.
    pub percent: Option<u8>,
    /// SlateDesk may set this fan (PWM output present and writable).
    pub controllable: bool,
    /// SlateDesk is regulating it right now (else the chip or BIOS does).
    pub controlled: bool,
    pub guarded: bool,
    pub setting: FanSetting,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FansReport {
    pub fans: Vec<FanInfo>,
    pub cpu_temp_c: Option<f64>,
    pub guard_temp_c: f64,
    pub min_percent: u8,
    /// PWM outputs exist, but the kiosk account may not write them (udev rule missing).
    pub needs_access: bool,
}

pub struct FanService {
    root: PathBuf,
    settings_path: PathBuf,
    restore_path: Option<PathBuf>,
    state: Mutex<FanState>,
}

impl FanService {
    pub fn new(root: PathBuf, config_dir: &Path, runtime_dir: Option<PathBuf>) -> Self {
        let settings_path = config_dir.join(SETTINGS_FILE);
        let settings = fs::read_to_string(&settings_path)
            .ok()
            .and_then(|text| serde_json::from_str::<SettingsFile>(&text).ok())
            .map(|file| {
                file.fans
                    .into_iter()
                    .filter(|(_, setting)| setting.validate().is_ok())
                    .collect()
            })
            .unwrap_or_default();
        let restore_path = runtime_dir.map(|dir| dir.join(RESTORE_FILE));
        // Left by a run of this boot that ended without giving the fans back.
        let original = restore_path
            .as_deref()
            .and_then(|path| fs::read_to_string(path).ok())
            .map(|text| parse_restore(&text))
            .unwrap_or_default();
        FanService {
            root,
            settings_path,
            restore_path,
            state: Mutex::new(FanState {
                settings,
                original,
                guarded: BTreeSet::new(),
            }),
        }
    }

    pub fn system(config_dir: &Path) -> Self {
        let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
        Self::new(PathBuf::from("/sys/class/hwmon"), config_dir, runtime)
    }

    fn save_restore(&self, state: &FanState) {
        let Some(path) = &self.restore_path else {
            return;
        };
        let result = if state.original.is_empty() {
            match fs::remove_file(path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            }
        } else {
            fs::write(path, format_restore(&state.original))
        };
        if let Err(e) = result {
            log::warn!("Lüfter: {} nicht geschrieben: {e}", path.display());
        }
    }

    fn give_back(id: &str, original: &Original) {
        let result = write_value(&original.enable_path, &original.enable).and_then(|()| {
            if original.enable == MANUAL {
                write_value(&original.pwm_path, &original.pwm)
            } else {
                Ok(())
            }
        });
        match result {
            Ok(()) => log::info!("Lüfter {id}: wieder automatisch"),
            Err(e) => log::warn!("Lüfter {id} nicht zurückgegeben: {e}"),
        }
    }

    /// One control step: sets every fan SlateDesk regulates, gives back the others.
    pub fn apply(&self, temp: Option<f64>) {
        let mut state = lock(&self.state);
        let regulating = state.settings.values().any(|s| *s != FanSetting::Auto);
        if !regulating && state.original.is_empty() {
            state.guarded.clear();
            return;
        }
        let hot = temp.is_some_and(|t| t >= GUARD_TEMP_C);
        state.guarded.clear();
        for channel in scan(&self.root) {
            let Some((pwm, enable)) = channel.outputs() else {
                continue;
            };
            let setting = state
                .settings
                .get(&channel.id)
                .copied()
                .unwrap_or(FanSetting::Auto);
            let Some(mut percent) = setting.target(temp) else {
                if let Some(original) = state.original.remove(&channel.id) {
                    Self::give_back(&channel.id, &original);
                    self.save_restore(&state);
                }
                continue;
            };
            if hot {
                percent = 100;
                state.guarded.insert(channel.id.clone());
            }
            let Some(current) = read_trim(enable) else {
                continue;
            };
            if current != MANUAL {
                if !state.original.contains_key(&channel.id) {
                    let Some(pwm_value) = read_trim(pwm) else {
                        continue;
                    };
                    state.original.insert(
                        channel.id.clone(),
                        Original {
                            enable_path: enable.to_path_buf(),
                            enable: current,
                            pwm_path: pwm.to_path_buf(),
                            pwm: pwm_value,
                        },
                    );
                    // Noted before taking over: a crash right after still gives it back.
                    self.save_restore(&state);
                    log::info!("Lüfter {}: von SlateDesk geregelt", channel.id);
                }
                if let Err(e) = write_value(enable, MANUAL) {
                    log::warn!("Lüfter {}: {e}", channel.id);
                    continue;
                }
            } else if !state.original.contains_key(&channel.id) {
                // Already manual before SlateDesk (another tool, the BIOS) – note its duty.
                let Some(pwm_value) = read_trim(pwm) else {
                    continue;
                };
                state.original.insert(
                    channel.id.clone(),
                    Original {
                        enable_path: enable.to_path_buf(),
                        enable: current,
                        pwm_path: pwm.to_path_buf(),
                        pwm: pwm_value,
                    },
                );
                self.save_restore(&state);
            }
            let wanted = duty(percent);
            if read_trim(pwm).and_then(|v| v.parse::<u16>().ok()) != Some(wanted) {
                if let Err(e) = write_value(pwm, &wanted.to_string()) {
                    log::warn!("Lüfter {}: {e}", channel.id);
                }
            }
        }
    }

    /// Every fan back to the chip or BIOS (app exit).
    pub fn restore_all(&self) {
        let mut state = lock(&self.state);
        for (id, original) in std::mem::take(&mut state.original) {
            Self::give_back(&id, &original);
        }
        self.save_restore(&state);
    }

    pub fn report(&self, temp: Option<f64>) -> FansReport {
        let state = lock(&self.state);
        let channels = scan(&self.root);
        let needs_access = channels
            .iter()
            .any(|c| c.outputs().is_some() && !c.controllable());
        FansReport {
            fans: channels
                .iter()
                .map(|c| FanInfo {
                    id: c.id.clone(),
                    name: c.name.clone(),
                    chip: c.chip.clone(),
                    rpm: c.rpm(),
                    percent: c.percent(),
                    controllable: c.controllable(),
                    controlled: state.original.contains_key(&c.id),
                    guarded: state.guarded.contains(&c.id),
                    setting: state
                        .settings
                        .get(&c.id)
                        .copied()
                        .unwrap_or(FanSetting::Auto),
                })
                .collect(),
            cpu_temp_c: temp,
            guard_temp_c: GUARD_TEMP_C,
            min_percent: MIN_PERCENT,
            needs_access,
        }
    }

    /// Stores the setting of fan `id` and applies it right away.
    pub fn set(&self, id: &str, setting: FanSetting, temp: Option<f64>) -> Result<(), String> {
        let setting = setting.validate()?;
        let channel = scan(&self.root)
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| "Lüfter nicht gefunden".to_string())?;
        if setting != FanSetting::Auto && !channel.controllable() {
            return Err("Dieser Lüfter lässt sich nicht steuern".to_string());
        }
        {
            let mut state = lock(&self.state);
            if setting == FanSetting::Auto {
                state.settings.remove(id);
            } else {
                state.settings.insert(id.to_string(), setting);
            }
            let file = SettingsFile {
                fans: state.settings.clone(),
            };
            let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
            let tmp = self.settings_path.with_extension("json.tmp");
            fs::write(&tmp, json)
                .and_then(|()| fs::rename(&tmp, &self.settings_path))
                .map_err(|e| format!("Einstellung nicht gespeichert: {e}"))?;
        }
        log::info!("Lüfter {id}: {setting:?}");
        self.apply(temp);
        Ok(())
    }
}

/// One line per fan: `<pwmN_enable> <value> <pwmN> <value> <id>` – read by fans-restore.sh.
fn format_restore(original: &BTreeMap<String, Original>) -> String {
    original
        .iter()
        .map(|(id, o)| {
            format!(
                "{} {} {} {} {id}\n",
                o.enable_path.display(),
                o.enable,
                o.pwm_path.display(),
                o.pwm
            )
        })
        .collect()
}

fn parse_restore(text: &str) -> BTreeMap<String, Original> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let (enable_path, enable, pwm_path, pwm, id) = (
                parts.next()?,
                parts.next()?,
                parts.next()?,
                parts.next()?,
                parts.next()?,
            );
            Some((
                id.to_string(),
                Original {
                    enable_path: PathBuf::from(enable_path),
                    enable: enable.to_string(),
                    pwm_path: PathBuf::from(pwm_path),
                    pwm: pwm.to_string(),
                },
            ))
        })
        .collect()
}

/// Control loop, started once at app start.
pub async fn run(service: Arc<FanService>) {
    loop {
        let step = Arc::clone(&service);
        let _ =
            tokio::task::spawn_blocking(move || step.apply(crate::system::read_cpu_temp())).await;
        tokio::time::sleep(CONTROL_EVERY).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Sandbox {
        dir: PathBuf,
    }

    impl Sandbox {
        /// hwmon0: CPU sensor only; hwmon1: nct6798 with fan1 + pwm1 (chip mode 5) and pwm2
        /// without a fan; hwmon2: a read-only fan (no PWM).
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("slatedesk-fans-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            let hwmon = dir.join("hwmon");
            let write = |file: &str, value: &str| {
                let path = hwmon.join(file);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, value).unwrap();
            };
            write("hwmon0/name", "coretemp\n");
            write("hwmon0/temp1_input", "45000\n");
            write("hwmon1/name", "nct6798\n");
            write("hwmon1/fan1_input", "812\n");
            write("hwmon1/fan1_label", "CPU Fan\n");
            write("hwmon1/pwm1", "128\n");
            write("hwmon1/pwm1_enable", "5\n");
            write("hwmon1/pwm2", "255\n");
            write("hwmon1/pwm2_enable", "2\n");
            write("hwmon2/name", "hp_wmi_sensors\n");
            write("hwmon2/fan1_input", "1500\n");
            fs::create_dir_all(dir.join("config")).unwrap();
            fs::create_dir_all(dir.join("run")).unwrap();
            Sandbox { dir }
        }

        fn service(&self) -> FanService {
            FanService::new(
                self.dir.join("hwmon"),
                &self.dir.join("config"),
                Some(self.dir.join("run")),
            )
        }

        fn read(&self, file: &str) -> String {
            fs::read_to_string(self.dir.join("hwmon").join(file))
                .unwrap()
                .trim()
                .to_string()
        }

        fn restore_file(&self) -> Option<String> {
            fs::read_to_string(self.dir.join("run").join(RESTORE_FILE)).ok()
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    const FAN: &str = "nct6798--1";

    #[test]
    fn finds_fans_and_outputs() {
        let sandbox = Sandbox::new("scan");
        let report = sandbox.service().report(Some(40.0));
        let fans: Vec<_> = report
            .fans
            .iter()
            .map(|f| {
                (
                    f.id.as_str(),
                    f.name.as_str(),
                    f.rpm,
                    f.percent,
                    f.controllable,
                )
            })
            .collect();
        assert_eq!(
            fans,
            [
                (FAN, "CPU Fan", Some(812), Some(50), true),
                ("nct6798--2", "Lüfter 2", None, Some(100), true),
                ("hp_wmi_sensors--1", "Lüfter 1", Some(1500), None, false),
            ]
        );
        assert!(!report.needs_access);
        assert!(report
            .fans
            .iter()
            .all(|f| f.setting == FanSetting::Auto && !f.controlled));
    }

    #[test]
    fn settings_are_checked() {
        assert!(FanSetting::Fixed { percent: 10 }.validate().is_err());
        assert!(FanSetting::Fixed { percent: 100 }.validate().is_ok());
        let curve = |min_temp, max_temp, min_percent| FanSetting::Curve {
            min_temp,
            max_temp,
            min_percent,
        };
        assert!(curve(50, 50, 30).validate().is_err());
        assert!(curve(40, 90, 30).validate().is_err());
        assert!(curve(40, 70, 0).validate().is_err());
        assert!(curve(40, 70, 30).validate().is_ok());
    }

    #[test]
    fn curve_rises_with_the_temperature() {
        let curve = FanSetting::Curve {
            min_temp: 40,
            max_temp: 70,
            min_percent: 30,
        };
        assert_eq!(curve.target(Some(30.0)), Some(30));
        assert_eq!(curve.target(Some(55.0)), Some(65));
        assert_eq!(curve.target(Some(80.0)), Some(100));
        assert_eq!(curve.target(None), Some(100), "no temperature – full speed");
        assert_eq!(FanSetting::Auto.target(Some(90.0)), None);
    }

    #[test]
    fn takes_over_and_gives_back() {
        let sandbox = Sandbox::new("control");
        let service = sandbox.service();
        service
            .set(FAN, FanSetting::Fixed { percent: 40 }, Some(45.0))
            .unwrap();
        assert_eq!(sandbox.read("hwmon1/pwm1_enable"), "1");
        assert_eq!(sandbox.read("hwmon1/pwm1"), "102");
        // Noted for fans-restore.sh before the take-over.
        let restore = sandbox.restore_file().unwrap();
        assert!(
            restore.ends_with(&format!(
                "pwm1_enable 5 {}/hwmon/hwmon1/pwm1 128 {FAN}\n",
                sandbox.dir.display()
            )),
            "{restore}"
        );
        // The other output stays with the chip.
        assert_eq!(sandbox.read("hwmon1/pwm2_enable"), "2");
        assert!(service.report(Some(45.0)).fans[0].controlled);

        service.set(FAN, FanSetting::Auto, Some(45.0)).unwrap();
        assert_eq!(sandbox.read("hwmon1/pwm1_enable"), "5");
        assert_eq!(sandbox.restore_file(), None);
        assert!(!service.report(Some(45.0)).fans[0].controlled);
    }

    #[test]
    fn hot_cpu_means_full_speed() {
        let sandbox = Sandbox::new("guard");
        let service = sandbox.service();
        service
            .set(
                FAN,
                FanSetting::Fixed { percent: 30 },
                Some(GUARD_TEMP_C + 1.0),
            )
            .unwrap();
        assert_eq!(sandbox.read("hwmon1/pwm1"), "255");
        assert!(service.report(None).fans[0].guarded);
        service.apply(Some(50.0));
        assert_eq!(sandbox.read("hwmon1/pwm1"), "77");
    }

    #[test]
    fn settings_and_take_over_survive_a_restart() {
        let sandbox = Sandbox::new("restart");
        sandbox
            .service()
            .set(FAN, FanSetting::Fixed { percent: 60 }, Some(40.0))
            .unwrap();
        // A crash: the next run of this boot finds the chip mode in the runtime directory.
        let next = sandbox.service();
        assert_eq!(
            next.report(Some(40.0)).fans[0].setting,
            FanSetting::Fixed { percent: 60 }
        );
        next.restore_all();
        assert_eq!(sandbox.read("hwmon1/pwm1_enable"), "5");
        assert_eq!(sandbox.restore_file(), None);
    }

    #[test]
    fn refuses_fans_it_cannot_control() {
        let sandbox = Sandbox::new("refuse");
        let service = sandbox.service();
        assert_eq!(
            service.set("hp_wmi_sensors--1", FanSetting::Fixed { percent: 50 }, None),
            Err("Dieser Lüfter lässt sich nicht steuern".to_string())
        );
        assert_eq!(
            service.set("nope", FanSetting::Auto, None),
            Err("Lüfter nicht gefunden".to_string())
        );
    }
}
