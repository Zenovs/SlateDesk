//! ICS/webcal calendars for the calendar widgets. Recurrences (RRULE, RDATE, EXDATE), moved or
//! cancelled instances (RECURRENCE-ID) and Windows/Outlook time zone names are resolved here,
//! so the frontend only gets plain instances with epoch-ms times. Private events (CLASS:PRIVATE
//! or CONFIDENTIAL) only show up as "Privat" – the kiosk is visible to visitors.

use crate::http::{describe_error, parse_web_url, read_body_limited, HttpClient};
use chrono::{
    DateTime, Datelike, Duration as Span, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, Offset,
    TimeZone, Utc,
};
use chrono_tz::Tz;
use futures_util::future::join_all;
use icalendar::parser::{Component, Property};
use reqwest::header::ACCEPT;
use rrule::{Frequency, RRule, RRuleSet, Unvalidated};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

const MAX_SOURCES: usize = 20;
const MAX_RANGE_DAYS: i64 = 400;
const CALENDAR_TIMEOUT: Duration = Duration::from_secs(20);
const CALENDAR_MAX_BYTES: usize = 10 * 1024 * 1024;
/// Upper bound of generated recurrences per event (daily since 2000 is ~10'000).
const MAX_ITERATIONS: usize = 50_000;
const MAX_EVENTS: usize = 5_000;
const TEXT_MAX_CHARS: usize = 2_000;
const MAX_ALL_DAY_DAYS: i64 = 3_660;
/// Switches read per VTIMEZONE block (a yearly rule since 1601 is ~430).
const MAX_TZ_ONSETS: usize = 2_000;
/// Raw ICS per URL: several widgets and the web UI ask for the same calendars.
const ICS_CACHE_TTL: Duration = Duration::from_secs(300);
const ICS_CACHE_MAX_ENTRIES: usize = 32;
const PRIVATE_TITLE: &str = "Privat";

/// Windows time zone names (Outlook/Exchange) → IANA, after CLDR's windowsZones.
const WINDOWS_ZONES: &[(&str, Tz)] = &[
    ("W. Europe Standard Time", chrono_tz::Europe::Zurich),
    ("Central Europe Standard Time", chrono_tz::Europe::Budapest),
    ("Central European Standard Time", chrono_tz::Europe::Warsaw),
    ("Romance Standard Time", chrono_tz::Europe::Paris),
    ("GMT Standard Time", chrono_tz::Europe::London),
    ("Greenwich Standard Time", chrono_tz::Atlantic::Reykjavik),
    ("UTC", chrono_tz::UTC),
    ("Coordinated Universal Time", chrono_tz::UTC),
    ("E. Europe Standard Time", chrono_tz::Europe::Chisinau),
    ("FLE Standard Time", chrono_tz::Europe::Helsinki),
    ("GTB Standard Time", chrono_tz::Europe::Bucharest),
    ("Russian Standard Time", chrono_tz::Europe::Moscow),
    ("Turkey Standard Time", chrono_tz::Europe::Istanbul),
    ("Israel Standard Time", chrono_tz::Asia::Jerusalem),
    ("Egypt Standard Time", chrono_tz::Africa::Cairo),
    (
        "South Africa Standard Time",
        chrono_tz::Africa::Johannesburg,
    ),
    ("W. Central Africa Standard Time", chrono_tz::Africa::Lagos),
    ("Morocco Standard Time", chrono_tz::Africa::Casablanca),
    ("Arab Standard Time", chrono_tz::Asia::Riyadh),
    ("Arabian Standard Time", chrono_tz::Asia::Dubai),
    ("Iran Standard Time", chrono_tz::Asia::Tehran),
    ("Pakistan Standard Time", chrono_tz::Asia::Karachi),
    ("India Standard Time", chrono_tz::Asia::Kolkata),
    ("Bangladesh Standard Time", chrono_tz::Asia::Dhaka),
    ("SE Asia Standard Time", chrono_tz::Asia::Bangkok),
    ("China Standard Time", chrono_tz::Asia::Shanghai),
    ("Singapore Standard Time", chrono_tz::Asia::Singapore),
    ("Taipei Standard Time", chrono_tz::Asia::Taipei),
    ("Tokyo Standard Time", chrono_tz::Asia::Tokyo),
    ("Korea Standard Time", chrono_tz::Asia::Seoul),
    ("W. Australia Standard Time", chrono_tz::Australia::Perth),
    (
        "Cen. Australia Standard Time",
        chrono_tz::Australia::Adelaide,
    ),
    ("E. Australia Standard Time", chrono_tz::Australia::Brisbane),
    ("AUS Eastern Standard Time", chrono_tz::Australia::Sydney),
    ("New Zealand Standard Time", chrono_tz::Pacific::Auckland),
    ("Hawaiian Standard Time", chrono_tz::Pacific::Honolulu),
    ("Alaskan Standard Time", chrono_tz::America::Anchorage),
    ("Pacific Standard Time", chrono_tz::America::Los_Angeles),
    ("US Mountain Standard Time", chrono_tz::America::Phoenix),
    ("Mountain Standard Time", chrono_tz::America::Denver),
    ("Central Standard Time", chrono_tz::America::Chicago),
    (
        "Central Standard Time (Mexico)",
        chrono_tz::America::Mexico_City,
    ),
    ("Canada Central Standard Time", chrono_tz::America::Regina),
    ("Eastern Standard Time", chrono_tz::America::New_York),
    ("Atlantic Standard Time", chrono_tz::America::Halifax),
    ("SA Pacific Standard Time", chrono_tz::America::Bogota),
    (
        "E. South America Standard Time",
        chrono_tz::America::Sao_Paulo,
    ),
    (
        "Argentina Standard Time",
        chrono_tz::America::Argentina::Buenos_Aires,
    ),
];

/// Localized Outlook display names, e.g. "(UTC+01:00) Amsterdam, Berlin, Bern, Rom, …" or
/// "(UTC-05:00) Eastern Time (US & Canada)" – matched as lowercase substrings, first wins.
const CITY_HINTS: &[(&str, Tz)] = &[
    ("bern", chrono_tz::Europe::Zurich),
    ("zürich", chrono_tz::Europe::Zurich),
    ("zurich", chrono_tz::Europe::Zurich),
    ("amsterdam", chrono_tz::Europe::Zurich),
    ("brüssel", chrono_tz::Europe::Paris),
    ("brussels", chrono_tz::Europe::Paris),
    ("paris", chrono_tz::Europe::Paris),
    ("london", chrono_tz::Europe::London),
    ("dublin", chrono_tz::Europe::London),
    ("belgrad", chrono_tz::Europe::Budapest),
    ("prag", chrono_tz::Europe::Budapest),
    ("sarajevo", chrono_tz::Europe::Warsaw),
    ("warschau", chrono_tz::Europe::Warsaw),
    ("warsaw", chrono_tz::Europe::Warsaw),
    ("athen", chrono_tz::Europe::Athens),
    ("helsinki", chrono_tz::Europe::Helsinki),
    ("istanbul", chrono_tz::Europe::Istanbul),
    ("moskau", chrono_tz::Europe::Moscow),
    ("moscow", chrono_tz::Europe::Moscow),
    ("jerusalem", chrono_tz::Asia::Jerusalem),
    ("abu dhabi", chrono_tz::Asia::Dubai),
    ("neu-delhi", chrono_tz::Asia::Kolkata),
    ("new delhi", chrono_tz::Asia::Kolkata),
    ("peking", chrono_tz::Asia::Shanghai),
    ("beijing", chrono_tz::Asia::Shanghai),
    ("singapur", chrono_tz::Asia::Singapore),
    ("singapore", chrono_tz::Asia::Singapore),
    ("tokio", chrono_tz::Asia::Tokyo),
    ("tokyo", chrono_tz::Asia::Tokyo),
    ("sydney", chrono_tz::Australia::Sydney),
    ("auckland", chrono_tz::Pacific::Auckland),
    ("coordinated universal time", chrono_tz::UTC),
    ("koordinierte weltzeit", chrono_tz::UTC),
    ("eastern time", chrono_tz::America::New_York),
    ("central time (us", chrono_tz::America::Chicago),
    ("mountain time (us", chrono_tz::America::Denver),
    ("pacific time", chrono_tz::America::Los_Angeles),
    ("atlantic time", chrono_tz::America::Halifax),
    ("arizona", chrono_tz::America::Phoenix),
    ("alaska", chrono_tz::America::Anchorage),
    ("hawaii", chrono_tz::Pacific::Honolulu),
    ("brasilia", chrono_tz::America::Sao_Paulo),
    ("buenos aires", chrono_tz::America::Argentina::Buenos_Aires),
];

/// URL → (fetched at, ICS text).
type IcsCache = HashMap<String, (Instant, Arc<str>)>;

static ICS_CACHE: LazyLock<Mutex<IcsCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Deserialize)]
pub struct CalendarSource {
    url: String,
    name: Option<String>,
    color: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    id: String,
    title: String,
    start: i64,
    end: i64,
    all_day: bool,
    location: Option<String>,
    description: Option<String>,
    source: String,
    color: Option<String>,
    private: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalendarError {
    url: String,
    error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalendarResult {
    events: Vec<CalendarEvent>,
    errors: Vec<CalendarError>,
}

// ---------------------------------------------------------------------------
// Time zones and values
// ---------------------------------------------------------------------------

fn clean_tzid(raw: &str) -> &str {
    raw.trim().trim_matches('"').trim()
}

/// Exact names: IANA (also inside a path) and Windows names.
fn resolve_named(id: &str) -> Option<Tz> {
    if id.is_empty() {
        return None;
    }
    if let Ok(tz) = id.parse::<Tz>() {
        return Some(tz);
    }
    // "/mozilla.org/20050126_1/Europe/Berlin", "/Europe/Zurich"
    let segments: Vec<&str> = id.split('/').filter(|s| !s.is_empty()).collect();
    for take in [3, 2] {
        if segments.len() >= take {
            if let Ok(tz) = segments[segments.len() - take..].join("/").parse::<Tz>() {
                return Some(tz);
            }
        }
    }
    WINDOWS_ZONES
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(id))
        .map(|(_, tz)| *tz)
}

/// Outlook display names, by the cities or regions they list.
fn resolve_hint(id: &str) -> Option<Tz> {
    let lower = id.to_lowercase();
    CITY_HINTS
        .iter()
        .find(|(city, _)| lower.contains(city))
        .map(|(_, tz)| *tz)
}

pub fn resolve_tzid(raw: &str) -> Option<Tz> {
    let id = clean_tzid(raw);
    resolve_named(id).or_else(|| resolve_hint(id))
}

/// `+0100`, `-0500`, `+053000` → seconds east of UTC.
fn parse_utc_offset(value: &str) -> Option<i32> {
    let value = value.trim();
    let (sign, digits) = match value.as_bytes().first()? {
        b'+' => (1, &value[1..]),
        b'-' => (-1, &value[1..]),
        _ => return None,
    };
    if !matches!(digits.len(), 4 | 6) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let part =
        |range: std::ops::Range<usize>| digits.get(range).and_then(|d| d.parse::<i32>().ok());
    let seconds = part(0..2)? * 3600 + part(2..4)? * 60 + part(4..6).unwrap_or(0);
    Some(sign * seconds)
}

/// The leading `(UTC+05:30)` / `(UTC)` / `(GMT-03:00)` of an Outlook display name.
fn utc_offset_prefix(id: &str) -> Option<i32> {
    let inner = id.trim().strip_prefix('(')?.split_once(')')?.0.trim();
    let rest = inner
        .strip_prefix("UTC")
        .or_else(|| inner.strip_prefix("GMT"))?
        .trim();
    if rest.is_empty() {
        return Some(0);
    }
    let (sign, digits) = match rest.as_bytes()[0] {
        b'+' => (1, &rest[1..]),
        b'-' => (-1, &rest[1..]),
        _ => return None,
    };
    let (hours, minutes) = digits.split_once(':').unwrap_or((digits, "0"));
    let (hours, minutes): (i32, i32) = (hours.parse().ok()?, minutes.parse().ok()?);
    (hours <= 14 && minutes < 60).then_some(sign * (hours * 3600 + minutes * 60))
}

fn offset_seconds(tz: Tz, at: DateTime<Utc>) -> i32 {
    tz.offset_from_utc_datetime(&at.naive_utc())
        .fix()
        .local_minus_utc()
}

/// A zone that keeps `offset` all year (no daylight saving): `Etc/GMT±h` for whole hours,
/// otherwise a zone like Asia/Kolkata (+05:30).
fn fixed_offset_zone(offset: i32, year: i32) -> Option<Tz> {
    if offset == 0 {
        return Some(chrono_tz::UTC);
    }
    if offset % 3600 == 0 {
        // POSIX sign: Etc/GMT-1 is UTC+1.
        let hours = offset / 3600;
        let name = if hours > 0 {
            format!("Etc/GMT-{hours}")
        } else {
            format!("Etc/GMT+{}", -hours)
        };
        if let Ok(tz) = name.parse() {
            return Some(tz);
        }
    }
    let probes: Vec<DateTime<Utc>> = [1, 7]
        .iter()
        .filter_map(|&month| Utc.with_ymd_and_hms(year, month, 15, 12, 0, 0).single())
        .collect();
    chrono_tz::TZ_VARIANTS
        .iter()
        .copied()
        .find(|tz| probes.iter().all(|at| offset_seconds(*tz, *at) == offset))
}

/// One STANDARD or DAYLIGHT block of a VTIMEZONE.
#[derive(Debug)]
struct Observance {
    offset_from: i32,
    offset_to: i32,
    /// Instants at which this block takes over, ascending.
    onsets: Vec<DateTime<Utc>>,
}

/// Local starts of a VTIMEZONE block's RRULE up to `horizon`.
fn rule_onsets(rule: &str, start: NaiveDateTime, horizon: NaiveDateTime) -> Vec<NaiveDateTime> {
    let (rule_text, until) = split_until(rule);
    let Ok(mut parsed) = rule_text.parse::<RRule<Unvalidated>>() else {
        return Vec::new();
    };
    if let Some(until) = until.and_then(|u| until_instant(&u, chrono_tz::UTC)) {
        parsed = parsed.until(until.with_timezone(&rrule::Tz::UTC));
    }
    // Local wall time stands in as UTC: the rule describes wall-clock switches.
    let dtstart = rrule::Tz::UTC.from_utc_datetime(&start);
    let Ok(rule) = parsed.validate(dtstart) else {
        return Vec::new();
    };
    let set = RRuleSet::new(dtstart).rrule(rule);
    (&set)
        .into_iter()
        .map(|at| at.naive_utc())
        .take_while(|at| *at <= horizon)
        .take(MAX_TZ_ONSETS)
        .collect()
}

fn read_observances(vtimezone: &Component<'_>, horizon: NaiveDateTime) -> Vec<Observance> {
    vtimezone
        .components
        .iter()
        .filter(|c| {
            let name = c.name.as_str();
            name.eq_ignore_ascii_case("STANDARD") || name.eq_ignore_ascii_case("DAYLIGHT")
        })
        .filter_map(|block| {
            let offset_to = parse_utc_offset(props(block, "TZOFFSETTO").next()?.val.as_str())?;
            let offset_from = props(block, "TZOFFSETFROM")
                .next()
                .and_then(|p| parse_utc_offset(p.val.as_str()))
                .unwrap_or(offset_to);
            let local = |value: &str| {
                let value = value.trim().trim_end_matches(['Z', 'z']);
                NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok()
            };
            let start = local(props(block, "DTSTART").next()?.val.as_str())?;
            let mut starts = vec![start];
            if let Some(rule) = props(block, "RRULE").next() {
                starts.extend(rule_onsets(rule.val.as_str(), start, horizon));
            }
            for rdate in props(block, "RDATE") {
                starts.extend(rdate.val.as_str().split(',').filter_map(local));
            }
            // Onsets are given in the local time before the switch.
            let mut onsets: Vec<DateTime<Utc>> = starts
                .into_iter()
                .map(|at| Utc.from_utc_datetime(&(at - Span::seconds(i64::from(offset_from)))))
                .collect();
            onsets.sort();
            onsets.dedup();
            Some(Observance {
                offset_from,
                offset_to,
                onsets,
            })
        })
        .collect()
}

/// UTC offset the VTIMEZONE defines at `at`: the block with the latest switch before it.
fn observance_offset(observances: &[Observance], at: DateTime<Utc>) -> Option<i32> {
    let latest = observances
        .iter()
        .filter_map(|o| {
            let index = o.onsets.partition_point(|onset| *onset <= at);
            index.checked_sub(1).map(|i| (o.onsets[i], o.offset_to))
        })
        .max_by_key(|(onset, _)| *onset);
    match latest {
        Some((_, offset)) => Some(offset),
        // Before the first switch: what the earliest block switches from.
        None => observances
            .iter()
            .filter_map(|o| o.onsets.first().map(|first| (*first, o.offset_from)))
            .min_by_key(|(first, _)| *first)
            .map(|(_, offset)| offset),
    }
}

/// The zone a VTIMEZONE describes (for a TZID no name resolves, e.g. "Customized Time Zone"):
/// the first known zone with the same offsets and switches in `reference`'s year, else its
/// offset at `reference` as a fixed zone.
fn zone_from_vtimezone(
    vtimezone: &Component<'_>,
    reference: DateTime<Utc>,
    display: Tz,
) -> Option<Tz> {
    let year = reference.year();
    let horizon = NaiveDate::from_ymd_opt(year + 1, 12, 31)?.and_time(NaiveTime::MIN);
    let observances = read_observances(vtimezone, horizon);
    if observances.is_empty() {
        return None;
    }
    let mut samples: Vec<DateTime<Utc>> = (1..=12)
        .filter_map(|month| Utc.with_ymd_and_hms(year, month, 15, 12, 0, 0).single())
        .collect();
    for onset in observances.iter().flat_map(|o| &o.onsets) {
        if onset.year() == year {
            samples.push(*onset - Span::minutes(1));
            samples.push(*onset + Span::minutes(1));
        }
    }
    let expected: Vec<i32> = samples
        .iter()
        .map(|at| observance_offset(&observances, *at))
        .collect::<Option<_>>()?;
    let fits = |tz: &Tz| {
        samples
            .iter()
            .zip(&expected)
            .all(|(at, offset)| offset_seconds(*tz, *at) == *offset)
    };
    [display, chrono_tz::UTC]
        .into_iter()
        .chain(WINDOWS_ZONES.iter().map(|(_, tz)| *tz))
        .chain(CITY_HINTS.iter().map(|(_, tz)| *tz))
        .chain(chrono_tz::TZ_VARIANTS.iter().copied())
        .find(fits)
        .or_else(|| fixed_offset_zone(observance_offset(&observances, reference)?, year))
}

/// TZIDs of the calendar's VTIMEZONEs that no name resolves, with the zone they describe.
fn vtimezone_zones(
    calendar: &icalendar::parser::Calendar<'_>,
    reference: DateTime<Utc>,
    display: Tz,
) -> HashMap<String, Tz> {
    calendar
        .components
        .iter()
        .filter(|c| c.name.as_str().eq_ignore_ascii_case("VTIMEZONE"))
        .filter_map(|c| {
            let id = clean_tzid(props(c, "TZID").next()?.val.as_str()).to_string();
            if resolve_named(&id).is_some() {
                return None;
            }
            let tz = zone_from_vtimezone(c, reference, display)?;
            Some((id, tz))
        })
        .collect()
}

/// The kiosk's own zone – all-day events are anchored at its local midnight because that is
/// where the frontend renders them.
fn system_tz() -> Tz {
    std::env::var("TZ")
        .ok()
        .and_then(|v| resolve_tzid(v.trim_start_matches(':')))
        .or_else(|| {
            std::fs::read_link("/etc/localtime")
                .ok()
                .and_then(|target| {
                    let target = target.to_string_lossy().into_owned();
                    target
                        .split("zoneinfo/")
                        .nth(1)
                        .and_then(|name| name.parse().ok())
                })
        })
        .or_else(|| {
            std::fs::read_to_string("/etc/timezone")
                .ok()
                .and_then(|name| name.trim().parse().ok())
        })
        .unwrap_or(chrono_tz::Europe::Zurich)
}

#[derive(Debug, Clone, Copy)]
struct Zones<'a> {
    /// Anchor for DATE values (all-day).
    display: Tz,
    /// Zone of floating times (X-WR-TIMEZONE or the display zone).
    floating: Tz,
    /// Zones of the calendar's own VTIMEZONEs whose TZID is no known name.
    custom: &'a HashMap<String, Tz>,
}

impl Zones<'_> {
    /// Known names first, then the calendar's VTIMEZONE, then display-name hints and a
    /// leading `(UTC±hh:mm)`; only a TZID none of them explains counts as floating.
    fn for_tzid(&self, raw: &str) -> Option<Tz> {
        let id = clean_tzid(raw);
        resolve_named(id)
            .or_else(|| self.custom.get(id).copied())
            .or_else(|| resolve_hint(id))
            .or_else(|| fixed_offset_zone(utc_offset_prefix(id)?, Utc::now().year()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum EventTime {
    Date(NaiveDate),
    Utc(DateTime<Utc>),
    Local(NaiveDateTime, Tz),
}

/// Local time → instant; DST gaps move forward, ambiguous times take the first occurrence.
fn localize(naive: NaiveDateTime, tz: Tz) -> DateTime<Tz> {
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(dt) | LocalResult::Ambiguous(dt, _) => dt,
        LocalResult::None => tz
            .from_local_datetime(&(naive + Span::hours(1)))
            .earliest()
            .unwrap_or_else(|| tz.from_utc_datetime(&naive)),
    }
}

impl EventTime {
    fn is_date(&self) -> bool {
        matches!(self, EventTime::Date(_))
    }

    /// Zone in which recurrences of this start are computed.
    fn zone(&self, zones: &Zones) -> Tz {
        match self {
            EventTime::Date(_) => zones.display,
            EventTime::Utc(_) => chrono_tz::UTC,
            EventTime::Local(_, tz) => *tz,
        }
    }

    fn resolve(&self, zones: &Zones) -> DateTime<Tz> {
        match self {
            EventTime::Date(date) => localize(date.and_time(NaiveTime::MIN), zones.display),
            EventTime::Utc(dt) => dt.with_timezone(&chrono_tz::UTC),
            EventTime::Local(naive, tz) => localize(*naive, *tz),
        }
    }
}

fn parse_date(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value.get(..8)?, "%Y%m%d").ok()
}

fn parse_time_value(
    value: &str,
    is_date: bool,
    tzid: Option<&str>,
    zones: &Zones,
) -> Option<EventTime> {
    let value = value.trim();
    if is_date || value.len() == 8 {
        return parse_date(value).map(EventTime::Date);
    }
    let (body, utc) = match value.strip_suffix(['Z', 'z']) {
        Some(body) => (body, true),
        None => (value, false),
    };
    let naive = NaiveDateTime::parse_from_str(body, "%Y%m%dT%H%M%S")
        .or_else(|_| NaiveDateTime::parse_from_str(body, "%Y%m%dT%H%M"))
        .ok()?;
    if utc {
        return Some(EventTime::Utc(Utc.from_utc_datetime(&naive)));
    }
    let tz = tzid
        .and_then(|id| zones.for_tzid(id))
        .unwrap_or(zones.floating);
    Some(EventTime::Local(naive, tz))
}

/// ISO 8601 duration as used by DURATION (`P1D`, `PT1H30M`, `-PT15M`, `P2W`).
fn parse_duration(value: &str) -> Option<Span> {
    let value = value.trim();
    let (negative, rest) = match value.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, value.strip_prefix('+').unwrap_or(value)),
    };
    let rest = rest.strip_prefix('P')?;
    let mut total = Span::zero();
    let mut number = String::new();
    let mut in_time = false;
    for c in rest.chars() {
        match c {
            '0'..='9' => number.push(c),
            'T' => in_time = true,
            'W' | 'D' | 'H' | 'M' | 'S' => {
                let n: i64 = number.parse().ok()?;
                number.clear();
                let part = match (c, in_time) {
                    ('W', _) => Span::try_weeks(n),
                    ('D', _) => Span::try_days(n),
                    ('H', true) => Span::try_hours(n),
                    ('M', true) => Span::try_minutes(n),
                    ('S', true) => Span::try_seconds(n),
                    _ => None,
                }?;
                total = total.checked_add(&part)?;
            }
            _ => return None,
        }
    }
    if !number.is_empty() {
        return None;
    }
    Some(if negative { -total } else { total })
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

fn param<'a>(prop: &'a Property<'_>, key: &str) -> Option<&'a str> {
    prop.params
        .iter()
        .find(|p| p.key.as_str().eq_ignore_ascii_case(key))
        .and_then(|p| p.val.as_ref())
        .map(|v| v.as_str().trim_matches('"'))
}

fn props<'a, 'b>(
    comp: &'a Component<'b>,
    name: &'a str,
) -> impl Iterator<Item = &'a Property<'b>> + 'a {
    comp.properties
        .iter()
        .filter(move |p| p.name.as_str().eq_ignore_ascii_case(name))
}

fn time_prop(prop: &Property<'_>, zones: &Zones) -> Option<EventTime> {
    let is_date = param(prop, "VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE"));
    parse_time_value(prop.val.as_str(), is_date, param(prop, "TZID"), zones)
}

fn time_list<'a>(comp: &'a Component<'_>, name: &'a str, zones: &'a Zones) -> Vec<EventTime> {
    props(comp, name)
        .filter(|p| !param(p, "VALUE").is_some_and(|v| v.eq_ignore_ascii_case("PERIOD")))
        .flat_map(|p| {
            let is_date = param(p, "VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE"));
            let tzid = param(p, "TZID");
            p.val
                .as_str()
                .split(',')
                .filter_map(|v| parse_time_value(v, is_date, tzid, zones))
                .collect::<Vec<_>>()
        })
        .collect()
}

fn truncate(text: &str) -> String {
    if text.chars().count() <= TEXT_MAX_CHARS {
        text.to_string()
    } else {
        let cut: String = text.chars().take(TEXT_MAX_CHARS).collect();
        format!("{}…", cut.trim_end())
    }
}

fn text_prop(comp: &Component<'_>, name: &str) -> Option<String> {
    let prop = props(comp, name).next()?;
    let text = prop.val.clone().unescape_text();
    let text = text.as_str().trim();
    (!text.is_empty()).then(|| truncate(text))
}

#[derive(Debug, Clone)]
struct RawEvent {
    uid: String,
    title: String,
    location: Option<String>,
    description: Option<String>,
    start: EventTime,
    end: Option<EventTime>,
    duration: Option<Span>,
    rrule: Option<String>,
    rdates: Vec<EventTime>,
    exdates: Vec<EventTime>,
    recurrence_id: Option<EventTime>,
    cancelled: bool,
    private: bool,
}

fn read_event(comp: &Component<'_>, zones: &Zones) -> Option<RawEvent> {
    let start = props(comp, "DTSTART")
        .next()
        .and_then(|p| time_prop(p, zones))?;
    let title = text_prop(comp, "SUMMARY").unwrap_or_else(|| "(ohne Titel)".to_string());
    let uid = text_prop(comp, "UID").unwrap_or_else(|| format!("{title}@{start:?}"));
    let status = text_prop(comp, "STATUS").unwrap_or_default();
    let class = text_prop(comp, "CLASS").unwrap_or_default();
    Some(RawEvent {
        uid,
        title,
        location: text_prop(comp, "LOCATION"),
        description: text_prop(comp, "DESCRIPTION"),
        start,
        end: props(comp, "DTEND")
            .next()
            .and_then(|p| time_prop(p, zones)),
        duration: props(comp, "DURATION")
            .next()
            .and_then(|p| parse_duration(p.val.as_str())),
        rrule: props(comp, "RRULE")
            .next()
            .map(|p| p.val.as_str().trim().to_string()),
        rdates: time_list(comp, "RDATE", zones),
        exdates: time_list(comp, "EXDATE", zones),
        recurrence_id: props(comp, "RECURRENCE-ID")
            .next()
            .and_then(|p| time_prop(p, zones)),
        cancelled: status.eq_ignore_ascii_case("CANCELLED"),
        private: class.eq_ignore_ascii_case("PRIVATE")
            || class.eq_ignore_ascii_case("CONFIDENTIAL"),
    })
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/// How long one instance lasts: whole days for all-day events (DST-safe), else a fixed span.
#[derive(Debug, Clone, Copy)]
enum Length {
    Days(i64),
    Exact(Span),
}

fn event_length(ev: &RawEvent, zones: &Zones) -> Length {
    if let EventTime::Date(start) = ev.start {
        let days = match (ev.end, ev.duration) {
            (Some(EventTime::Date(end)), _) => (end - start).num_days(),
            (_, Some(duration)) => duration.num_days(),
            _ => 1,
        };
        return Length::Days(days.clamp(1, MAX_ALL_DAY_DAYS));
    }
    let start = ev.start.resolve(zones);
    let span = match (ev.end, ev.duration) {
        (Some(end), _) => end.resolve(zones) - start,
        (None, Some(duration)) => duration,
        (None, None) => Span::zero(),
    };
    Length::Exact(span.max(Span::zero()))
}

fn instance_end(start: DateTime<Tz>, length: Length) -> DateTime<Tz> {
    match length {
        Length::Days(days) => start
            .date_naive()
            .checked_add_signed(Span::days(days))
            .map(|end| localize(end.and_time(NaiveTime::MIN), start.timezone()))
            .unwrap_or(start),
        Length::Exact(span) => start.checked_add_signed(span).unwrap_or(start),
    }
}

/// Splits `UNTIL=` off the rule: its value type follows DTSTART (date, floating, UTC), which
/// the rrule crate cannot know, so it is resolved here.
fn split_until(rule: &str) -> (String, Option<String>) {
    let mut until = None;
    let parts: Vec<&str> = rule
        .trim_start_matches("RRULE:")
        .split(';')
        .filter(|part| {
            let value = part
                .get(..6)
                .filter(|key| key.eq_ignore_ascii_case("UNTIL="))
                .and_then(|_| part.get(6..))
                .filter(|v| !v.is_empty());
            if let Some(value) = value {
                until = Some(value.to_string());
            }
            value.is_none() && !part.is_empty()
        })
        .collect();
    (parts.join(";"), until)
}

fn until_instant(value: &str, zone: Tz) -> Option<DateTime<Utc>> {
    let value = value.trim();
    if value.len() == 8 {
        // Inclusive date → the end of that day.
        let next_day = parse_date(value)? + Span::days(1);
        return Some(
            (localize(next_day.and_time(NaiveTime::MIN), zone) - Span::seconds(1))
                .with_timezone(&Utc),
        );
    }
    let no_custom = HashMap::new();
    let zones = Zones {
        display: zone,
        floating: zone,
        custom: &no_custom,
    };
    parse_time_value(value, false, None, &zones).map(|t| t.resolve(&zones).with_timezone(&Utc))
}

/// Fixed-length period of a frequent rule; longer ones never exhaust [`MAX_ITERATIONS`].
fn rule_period(rule: &RRule<Unvalidated>) -> Option<Span> {
    let unit = match rule.get_freq() {
        Frequency::Secondly => 1,
        Frequency::Minutely => 60,
        Frequency::Hourly => 3_600,
        Frequency::Daily => 86_400,
        Frequency::Weekly => 7 * 86_400,
        Frequency::Monthly | Frequency::Yearly => return None,
    };
    Span::try_seconds(unit * i64::from(rule.get_interval().max(1)))
}

/// Where the expansion of `rule` may start instead of DTSTART. Without COUNT the pattern
/// repeats every `interval` periods of local wall time (the rrule crate iterates in it), so a
/// start a whole number of periods later yields the same instances from there on. A series
/// that began long ago (hourly since 2020) would otherwise use up [`MAX_ITERATIONS`] before
/// it reaches the window and silently disappear.
fn skip_ahead(
    dtstart: DateTime<rrule::Tz>,
    rule: &RRule<Unvalidated>,
    earliest: DateTime<Utc>,
) -> DateTime<rrule::Tz> {
    if rule.get_count().is_some() {
        return dtstart;
    }
    let Some(period) = rule_period(rule)
        .map(|p| p.num_seconds())
        .filter(|p| *p > 0)
    else {
        return dtstart;
    };
    let tz = dtstart.timezone();
    let start = dtstart.naive_local();
    let gap = (earliest.with_timezone(&tz).naive_local() - start).num_seconds();
    // One period of margin before the window.
    let steps = gap / period - 1;
    if steps <= 0 {
        return dtstart;
    }
    // A new start inside a DST gap would shift the time of day – take an earlier period.
    (0..3)
        .filter_map(|back| {
            let shift = Span::try_seconds((steps - back).checked_mul(period)?)?;
            match tz.from_local_datetime(&start.checked_add_signed(shift)?) {
                LocalResult::Single(at) => Some(at),
                _ => None,
            }
        })
        .next()
        .unwrap_or(dtstart)
}

/// The first instance the rule itself produces (DTSTART need not match the pattern).
fn first_rule_instance(
    rule: &RRule<Unvalidated>,
    dtstart: DateTime<rrule::Tz>,
) -> Option<DateTime<rrule::Tz>> {
    let rule = rule.clone().validate(dtstart).ok()?;
    RRuleSet::new(dtstart).rrule(rule).into_iter().next()
}

/// `earliest`: no instance starting before it can reach the window.
fn build_set(
    ev: &RawEvent,
    zone: Tz,
    start: DateTime<Tz>,
    zones: &Zones,
    earliest: DateTime<Utc>,
) -> Result<RRuleSet, String> {
    let rtz = rrule::Tz::Tz(zone);
    let dtstart = start.with_timezone(&rtz);
    let mut set = RRuleSet::new(dtstart);
    if let Some(rule) = &ev.rrule {
        let (rule_text, until) = split_until(rule);
        let mut parsed: RRule<Unvalidated> = rule_text.parse().map_err(|e| format!("{e}"))?;
        if let Some(until) = until {
            let until =
                until_instant(&until, zone).ok_or_else(|| format!("UNTIL ungültig: {until}"))?;
            parsed = parsed.until(until.with_timezone(&rrule::Tz::UTC));
        }
        // RFC 5545: DTSTART is the first of COUNT instances even when the pattern does not
        // produce it; the rrule crate counts pattern matches only, so the rule gets one less.
        let count = parsed.get_count();
        let unaligned = count.is_some() && first_rule_instance(&parsed, dtstart) != Some(dtstart);
        match count {
            Some(1) if unaligned => {}
            Some(n) if unaligned => {
                let rule = parsed.count(n - 1);
                set = set.rrule(rule.validate(dtstart).map_err(|e| format!("{e}"))?);
            }
            _ => {
                let rule_start = skip_ahead(dtstart, &parsed, earliest);
                set = RRuleSet::new(rule_start)
                    .rrule(parsed.validate(rule_start).map_err(|e| format!("{e}"))?);
            }
        }
    }
    // RFC 5545: DTSTART always counts as the first instance.
    set = set.rdate(dtstart);
    for rdate in &ev.rdates {
        set = set.rdate(rdate.resolve(zones).with_timezone(&rtz));
    }
    for exdate in &ev.exdates {
        set = set.exdate(exdate.resolve(zones).with_timezone(&rtz));
    }
    Ok(set)
}

fn overlaps(
    start: DateTime<Tz>,
    end: DateTime<Tz>,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> bool {
    if start >= end {
        start >= from && start < to
    } else {
        start < to && end > from
    }
}

/// Instances `(start, end)` of one VEVENT within `[from, to)`; `moved` holds the original
/// starts (epoch ms) that have their own RECURRENCE-ID component.
fn instances(
    ev: &RawEvent,
    zones: &Zones,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    moved: Option<&HashSet<i64>>,
) -> Vec<(DateTime<Tz>, DateTime<Tz>)> {
    let zone = ev.start.zone(zones);
    let start = ev.start.resolve(zones).with_timezone(&zone);
    let length = event_length(ev, zones);
    let single = || {
        let end = instance_end(start, length);
        if overlaps(start, end, from, to) {
            vec![(start, end)]
        } else {
            Vec::new()
        }
    };
    if ev.recurrence_id.is_some() || (ev.rrule.is_none() && ev.rdates.is_empty()) {
        return single();
    }
    let longest = match length {
        Length::Days(days) => Span::days(days),
        Length::Exact(span) => span,
    };
    let earliest = from.checked_sub_signed(longest).unwrap_or(from);
    let set = match build_set(ev, zone, start, zones, earliest) {
        Ok(set) => set,
        Err(e) => {
            log::debug!(
                "Kalender: Wiederholung von «{}» nicht auswertbar ({e})",
                ev.title
            );
            return single();
        }
    };

    let mut out = Vec::new();
    let mut last = None;
    for (n, occurrence) in set.into_iter().enumerate() {
        let begin = occurrence.with_timezone(&zone);
        if n >= MAX_ITERATIONS || begin >= to || out.len() >= MAX_EVENTS {
            break;
        }
        let key = begin.timestamp_millis();
        if last == Some(key) || moved.is_some_and(|m| m.contains(&key)) {
            continue;
        }
        last = Some(key);
        let end = instance_end(begin, length);
        if overlaps(begin, end, from, to) {
            out.push((begin, end));
        }
    }
    out
}

struct SourceMeta {
    key: String,
    name: String,
    color: Option<String>,
}

fn events_from_ics(
    text: &str,
    meta: &SourceMeta,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    display: Tz,
) -> Result<Vec<CalendarEvent>, String> {
    let unfolded = icalendar::parser::unfold(text);
    let calendar = icalendar::parser::read_calendar(&unfolded).map_err(|e| {
        let first = e
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("unbekannter Fehler");
        format!(
            "Kalender nicht lesbar: {}",
            first.chars().take(160).collect::<String>()
        )
    })?;
    let floating = calendar
        .properties
        .iter()
        .find(|p| p.name.as_str().eq_ignore_ascii_case("X-WR-TIMEZONE"))
        .and_then(|p| resolve_tzid(p.val.as_str()))
        .unwrap_or(display);
    let custom = vtimezone_zones(&calendar, from, display);
    let zones = Zones {
        display,
        floating,
        custom: &custom,
    };

    let raw: Vec<RawEvent> = calendar
        .components
        .iter()
        .filter(|c| c.name.as_str().eq_ignore_ascii_case("VEVENT"))
        .filter_map(|c| read_event(c, &zones))
        .collect();

    let mut moved: HashMap<&str, HashSet<i64>> = HashMap::new();
    for ev in &raw {
        if let Some(original) = ev.recurrence_id {
            moved
                .entry(ev.uid.as_str())
                .or_default()
                .insert(original.resolve(&zones).timestamp_millis());
        }
    }

    let mut events = Vec::new();
    for ev in raw.iter().filter(|ev| !ev.cancelled) {
        let (title, location, description) = if ev.private {
            (PRIVATE_TITLE.to_string(), None, None)
        } else {
            (
                ev.title.clone(),
                ev.location.clone(),
                ev.description.clone(),
            )
        };
        for (start, end) in instances(ev, &zones, from, to, moved.get(ev.uid.as_str())) {
            events.push(CalendarEvent {
                id: format!("{}:{}:{}", meta.key, ev.uid, start.timestamp_millis()),
                title: title.clone(),
                start: start.timestamp_millis(),
                end: end.timestamp_millis(),
                all_day: ev.start.is_date(),
                location: location.clone(),
                description: description.clone(),
                source: meta.name.clone(),
                color: meta.color.clone(),
                private: ev.private,
            });
            if events.len() >= MAX_EVENTS {
                break;
            }
        }
    }
    events.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| a.title.cmp(&b.title)));
    Ok(events)
}

/// `webcal://` and `webcals://` are plain HTTPS subscriptions.
fn normalize_calendar_url(url: &str) -> String {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    for prefix in ["webcals://", "webcal://"] {
        if lower.starts_with(prefix) {
            return format!("https://{}", &trimmed[prefix.len()..]);
        }
    }
    trimmed.to_string()
}

fn cached_ics(key: &str) -> Option<Arc<str>> {
    let cache = ICS_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    cache
        .get(key)
        .filter(|(at, _)| at.elapsed() < ICS_CACHE_TTL)
        .map(|(_, text)| Arc::clone(text))
}

fn store_ics(key: String, text: Arc<str>) {
    let mut cache = ICS_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    cache.retain(|_, (at, _)| at.elapsed() < ICS_CACHE_TTL);
    while cache.len() >= ICS_CACHE_MAX_ENTRIES {
        let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, (at, _))| *at)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        cache.remove(&oldest);
    }
    cache.insert(key, (Instant::now(), text));
}

/// RFC 5545 §3.1 unfolding on the raw bytes: a generator may fold inside a multi-byte UTF-8
/// character, and only the joined bytes decode to it.
fn unfold_bytes(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        let fold = match raw[i] {
            b'\r'
                if raw.get(i + 1) == Some(&b'\n')
                    && matches!(raw.get(i + 2), Some(b' ' | b'\t')) =>
            {
                3
            }
            b'\n' if matches!(raw.get(i + 1), Some(b' ' | b'\t')) => 2,
            _ => 0,
        };
        if fold == 0 {
            out.push(raw[i]);
            i += 1;
        } else {
            i += fold;
        }
    }
    out
}

/// The calendar file, from the 5-minute cache or freshly downloaded (already unfolded).
async fn load_ics(client: &reqwest::Client, url: &reqwest::Url) -> Result<Arc<str>, String> {
    if let Some(text) = cached_ics(url.as_str()) {
        return Ok(text);
    }
    let response = client
        .get(url.clone())
        .header(ACCEPT, "text/calendar, */*;q=0.5")
        .timeout(CALENDAR_TIMEOUT)
        .send()
        .await
        .map_err(|e| describe_error(&e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    let body = read_body_limited(response, CALENDAR_MAX_BYTES).await?;
    let unfolded = unfold_bytes(&body);
    let decoded = String::from_utf8_lossy(&unfolded);
    let trimmed = decoded.trim_start_matches('\u{feff}').trim_start();
    if !trimmed
        .get(..15)
        .is_some_and(|head| head.eq_ignore_ascii_case("BEGIN:VCALENDAR"))
    {
        // A login page or an error document instead of the calendar – never cached.
        return Err("Antwort ist keine Kalenderdatei (ICS)".to_string());
    }
    let text: Arc<str> = Arc::from(trimmed);
    store_ics(url.as_str().to_string(), Arc::clone(&text));
    Ok(text)
}

async fn fetch_calendar(
    client: &reqwest::Client,
    source: &CalendarSource,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    display: Tz,
) -> Result<Vec<CalendarEvent>, String> {
    let url = parse_web_url(&normalize_calendar_url(&source.url))?;
    let text = load_ics(client, &url).await?;
    let meta = SourceMeta {
        key: hex::encode(&Sha256::digest(source.url.as_bytes())[..4]),
        name: source
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| url.host_str().unwrap_or("Kalender").to_string()),
        color: source.color.clone().filter(|c| !c.trim().is_empty()),
    };
    tokio::task::spawn_blocking(move || events_from_ics(&text, &meta, from, to, display))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn calendar_events(
    sources: Vec<CalendarSource>,
    from_ms: i64,
    to_ms: i64,
    http: State<'_, HttpClient>,
) -> Result<CalendarResult, String> {
    if sources.len() > MAX_SOURCES {
        return Err(format!("Zu viele Kalender (maximal {MAX_SOURCES})"));
    }
    let (Some(from), Some(to)) = (
        Utc.timestamp_millis_opt(from_ms).single(),
        Utc.timestamp_millis_opt(to_ms).single(),
    ) else {
        return Err("Ungültiger Zeitraum".to_string());
    };
    if to <= from || (to - from).num_days() > MAX_RANGE_DAYS {
        return Err(format!(
            "Ungültiger Zeitraum (maximal {MAX_RANGE_DAYS} Tage)"
        ));
    }
    let display = system_tz();
    let results = join_all(
        sources
            .iter()
            .map(|source| fetch_calendar(&http.0, source, from, to, display)),
    )
    .await;

    let mut events = Vec::new();
    let mut errors = Vec::new();
    for (source, result) in sources.iter().zip(results) {
        match result {
            Ok(list) => events.extend(list),
            Err(error) => errors.push(CalendarError {
                url: source.url.clone(),
                error,
            }),
        }
    }
    events.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| a.title.cmp(&b.title)));
    events.truncate(MAX_EVENTS);
    Ok(CalendarResult { events, errors })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ZURICH: Tz = chrono_tz::Europe::Zurich;

    fn meta() -> SourceMeta {
        SourceMeta {
            key: "k".into(),
            name: "Büro".into(),
            color: Some("#ff0000".into()),
        }
    }

    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        ZURICH
            .with_ymd_and_hms(y, m, d, h, min, 0)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn ms(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        at(y, m, d, h, min).timestamp_millis()
    }

    fn parse(ics: &str, from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<CalendarEvent> {
        events_from_ics(&ics.replace('\n', "\r\n"), &meta(), from, to, ZURICH).unwrap()
    }

    #[test]
    fn resolves_iana_windows_and_outlook_zone_names() {
        assert_eq!(resolve_tzid("Europe/Zurich"), Some(ZURICH));
        assert_eq!(resolve_tzid("\"W. Europe Standard Time\""), Some(ZURICH));
        assert_eq!(
            resolve_tzid("/mozilla.org/20050126_1/Europe/Berlin"),
            Some(chrono_tz::Europe::Berlin)
        );
        assert_eq!(
            resolve_tzid("(UTC+01:00) Amsterdam, Berlin, Bern, Rom, Stockholm, Wien"),
            Some(ZURICH)
        );
        assert_eq!(
            resolve_tzid("Pacific Standard Time"),
            Some(chrono_tz::America::Los_Angeles)
        );
        assert_eq!(resolve_tzid("Customized Time Zone"), None);
    }

    #[test]
    fn resolves_outlook_display_names_and_offsets() {
        assert_eq!(
            resolve_tzid("(UTC-05:00) Eastern Time (US & Canada)"),
            Some(chrono_tz::America::New_York)
        );
        assert_eq!(
            resolve_tzid("(UTC) Coordinated Universal Time"),
            Some(chrono_tz::UTC)
        );
        assert_eq!(
            resolve_tzid("(UTC-08:00) Pacific Time (USA und Kanada)"),
            Some(chrono_tz::America::Los_Angeles)
        );
        assert_eq!(utc_offset_prefix("(UTC+05:30) Chennai"), Some(19_800));
        assert_eq!(
            utc_offset_prefix("(UTC-03:00) Cayenne, Fortaleza"),
            Some(-10_800)
        );
        assert_eq!(utc_offset_prefix("(UTC) Monrovia"), Some(0));
        assert_eq!(utc_offset_prefix("Customized Time Zone"), None);
        assert_eq!(parse_utc_offset("+0100"), Some(3_600));
        assert_eq!(parse_utc_offset("-0430"), Some(-16_200));
        assert_eq!(parse_utc_offset("0100"), None);
        assert_eq!(
            fixed_offset_zone(-10_800, 2026),
            Some(chrono_tz::Etc::GMTPlus3)
        );
        let kathmandu = fixed_offset_zone(20_700, 2026).unwrap();
        assert_eq!(offset_seconds(kathmandu, at(2026, 7, 1, 0, 0)), 20_700);
    }

    #[test]
    fn unknown_tzids_use_the_calendars_vtimezone() {
        let ics = "BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:Customized Time Zone
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VTIMEZONE
TZID:Kathmandu (eigene Zone)
BEGIN:STANDARD
DTSTART:16010101T000000
TZOFFSETFROM:+0545
TZOFFSETTO:+0545
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:ny-1
DTSTART;TZID=\"Customized Time Zone\":20261020T100000
DTEND;TZID=\"Customized Time Zone\":20261020T110000
SUMMARY:New York Sommerzeit
END:VEVENT
BEGIN:VEVENT
UID:ny-2
DTSTART;TZID=Customized Time Zone:20261110T100000
SUMMARY:New York Winterzeit
END:VEVENT
BEGIN:VEVENT
UID:np
DTSTART;TZID=Kathmandu (eigene Zone):20261020T100000
SUMMARY:Kathmandu
END:VEVENT
BEGIN:VEVENT
UID:cayenne
DTSTART;TZID=\"(UTC-03:00) Cayenne, Fortaleza\":20261021T100000
SUMMARY:Cayenne
END:VEVENT
END:VCALENDAR
";
        let events = parse(ics, at(2026, 10, 1, 0, 0), at(2026, 12, 1, 0, 0));
        let starts: Vec<(&str, i64)> = events.iter().map(|e| (e.title.as_str(), e.start)).collect();
        assert_eq!(
            starts,
            vec![
                // 10:00 EDT = 14:00 UTC = 16:00 in Zurich (summer time).
                ("Kathmandu", ms(2026, 10, 20, 6, 15)),
                ("New York Sommerzeit", ms(2026, 10, 20, 16, 0)),
                ("Cayenne", ms(2026, 10, 21, 15, 0)),
                // 10:00 EST = 15:00 UTC = 16:00 in Zurich (winter time).
                ("New York Winterzeit", ms(2026, 11, 10, 16, 0)),
            ]
        );
        assert_eq!(events[1].end - events[1].start, 60 * 60 * 1000);
    }

    #[test]
    fn folds_inside_utf8_characters_are_joined_before_decoding() {
        let raw = b"BEGIN:VEVENT\r\nSUMMARY:Gr\xC3\r\n \xBCnabfuhr\r\nLOCATION:Z\xC3\n\t\xBCrich\r\nEND:VEVENT\r\n";
        let text = String::from_utf8(unfold_bytes(raw)).unwrap();
        assert_eq!(
            text,
            "BEGIN:VEVENT\r\nSUMMARY:Grünabfuhr\r\nLOCATION:Zürich\r\nEND:VEVENT\r\n"
        );
        // Unfolding again changes nothing.
        assert_eq!(icalendar::parser::unfold(&text), text);
    }

    #[test]
    fn count_includes_an_unaligned_dtstart() {
        let ics = "BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:unaligned
DTSTART;TZID=Europe/Zurich:20261007T090000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=2
SUMMARY:Zwei Termine
END:VEVENT
BEGIN:VEVENT
UID:single
DTSTART;TZID=Europe/Zurich:20261007T100000
RRULE:FREQ=MONTHLY;BYMONTHDAY=15;COUNT=1
SUMMARY:Ein Termin
END:VEVENT
BEGIN:VEVENT
UID:aligned
DTSTART;TZID=Europe/Zurich:20261005T080000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=2
SUMMARY:Ausgerichtet
END:VEVENT
END:VCALENDAR
";
        let events = parse(ics, at(2026, 10, 1, 0, 0), at(2027, 1, 1, 0, 0));
        let starts = |title: &str| -> Vec<i64> {
            events
                .iter()
                .filter(|e| e.title == title)
                .map(|e| e.start)
                .collect()
        };
        assert_eq!(
            starts("Zwei Termine"),
            vec![ms(2026, 10, 7, 9, 0), ms(2026, 10, 12, 9, 0)]
        );
        assert_eq!(starts("Ein Termin"), vec![ms(2026, 10, 7, 10, 0)]);
        assert_eq!(
            starts("Ausgerichtet"),
            vec![ms(2026, 10, 5, 8, 0), ms(2026, 10, 12, 8, 0)]
        );
    }

    #[test]
    fn frequent_series_from_long_ago_still_show() {
        let ics = "BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:hourly
DTSTART:20200101T000000Z
DURATION:PT15M
RRULE:FREQ=HOURLY
SUMMARY:Stündlich
END:VEVENT
BEGIN:VEVENT
UID:biweekly
DTSTART;TZID=Europe/Zurich:20000103T090000
RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE
SUMMARY:Zweiwöchentlich
END:VEVENT
END:VCALENDAR
";
        let events = parse(ics, at(2026, 10, 13, 0, 0), at(2026, 10, 14, 0, 0));
        let hourly: Vec<&CalendarEvent> =
            events.iter().filter(|e| e.title == "Stündlich").collect();
        assert_eq!(hourly.len(), 24);
        // 2000-01-03 is a Monday; every second week from there – the week of 12.10.2026 is
        // off (1397 weeks later), the one of 19.10. on.
        assert!(events.iter().all(|e| e.title != "Zweiwöchentlich"));
        let week = parse(ics, at(2026, 10, 12, 0, 0), at(2026, 10, 26, 0, 0));
        let biweekly: Vec<i64> = week
            .iter()
            .filter(|e| e.title == "Zweiwöchentlich")
            .map(|e| e.start)
            .collect();
        assert_eq!(
            biweekly,
            vec![ms(2026, 10, 19, 9, 0), ms(2026, 10, 21, 9, 0)]
        );
    }

    #[test]
    fn skipping_ahead_keeps_the_pattern() {
        let none = HashMap::new();
        let zones = Zones {
            display: ZURICH,
            floating: ZURICH,
            custom: &none,
        };
        let (from, to) = (at(2026, 10, 20, 0, 0), at(2026, 10, 30, 0, 0));
        for rule in [
            "FREQ=HOURLY;INTERVAL=5",
            "FREQ=DAILY;INTERVAL=3;BYHOUR=9,17",
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
            "FREQ=MINUTELY;INTERVAL=7;BYHOUR=2",
            "FREQ=DAILY;BYMONTHDAY=1,25,26",
        ] {
            let ev = RawEvent {
                uid: "x".into(),
                title: "x".into(),
                location: None,
                description: None,
                start: EventTime::Local(
                    NaiveDate::from_ymd_opt(2025, 11, 3)
                        .unwrap()
                        .and_hms_opt(2, 30, 0)
                        .unwrap(),
                    ZURICH,
                ),
                end: None,
                duration: None,
                rrule: Some(rule.into()),
                rdates: Vec::new(),
                exdates: Vec::new(),
                recurrence_id: None,
                cancelled: false,
                private: false,
            };
            let start = ev.start.resolve(&zones);
            let window = |earliest: DateTime<Utc>| -> Vec<i64> {
                let set = build_set(&ev, ZURICH, start, &zones, earliest).unwrap();
                (&set)
                    .into_iter()
                    .map(|at| at.timestamp_millis())
                    .skip_while(|ms| *ms < from.timestamp_millis())
                    .take_while(|ms| *ms < to.timestamp_millis())
                    .collect()
            };
            let full = window(start.with_timezone(&Utc));
            assert!(!full.is_empty(), "{rule}");
            assert_eq!(window(from), full, "{rule}");
        }
    }

    #[test]
    fn parses_durations() {
        assert_eq!(parse_duration("PT1H30M"), Some(Span::minutes(90)));
        assert_eq!(parse_duration("P1D"), Some(Span::days(1)));
        assert_eq!(parse_duration("P1W"), Some(Span::weeks(1)));
        assert_eq!(parse_duration("-PT15M"), Some(-Span::minutes(15)));
        assert_eq!(parse_duration("P1H"), None);
        assert_eq!(parse_duration("1H"), None);
    }

    #[test]
    fn single_timed_and_all_day_events() {
        let ics = "BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//DE
BEGIN:VEVENT
UID:a1
DTSTART;TZID=W. Europe Standard Time:20261014T090000
DTEND;TZID=W. Europe Standard Time:20261014T103000
SUMMARY:Sitzung\\, Team
LOCATION:Raum 1
DESCRIPTION:Zeile 1\\nZeile 2
CLASS:PUBLIC
END:VEVENT
BEGIN:VEVENT
UID:a2
DTSTART;VALUE=DATE:20261015
DTEND;VALUE=DATE:20261017
SUMMARY:Messe
END:VEVENT
BEGIN:VEVENT
UID:a3
DTSTART:20261201T080000Z
SUMMARY:Ausserhalb
END:VEVENT
END:VCALENDAR
";
        let events = parse(ics, at(2026, 10, 13, 0, 0), at(2026, 10, 20, 0, 0));
        assert_eq!(events.len(), 2);
        let meeting = &events[0];
        assert_eq!(meeting.title, "Sitzung, Team");
        assert_eq!(meeting.start, ms(2026, 10, 14, 9, 0));
        assert_eq!(meeting.end, ms(2026, 10, 14, 10, 30));
        assert_eq!(meeting.description.as_deref(), Some("Zeile 1\nZeile 2"));
        assert_eq!(meeting.location.as_deref(), Some("Raum 1"));
        assert!(!meeting.private && !meeting.all_day);
        assert_eq!(meeting.color.as_deref(), Some("#ff0000"));
        assert_eq!(meeting.source, "Büro");
        let fair = &events[1];
        assert!(fair.all_day);
        assert_eq!(fair.start, ms(2026, 10, 15, 0, 0));
        assert_eq!(fair.end, ms(2026, 10, 17, 0, 0));
    }

    /// Shaped like an Exchange/Outlook export: VTIMEZONE with a Windows name, folded UID,
    /// LANGUAGE parameters, X-MICROSOFT properties, VALARM, a weekly series with an EXDATE and
    /// a moved instance, a private appointment and a cancelled one.
    const OUTLOOK_ICS: &str = "BEGIN:VCALENDAR
METHOD:PUBLISH
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
X-WR-CALNAME:Kalender
BEGIN:VTIMEZONE
TZID:W. Europe Standard Time
BEGIN:STANDARD
DTSTART:16010101T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VTIMEZONE
TZID:Eastern Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
DESCRIPTION:Wöchentliche Abstimmung\\n\\nTraktanden folgen.\\n
RRULE:FREQ=WEEKLY;UNTIL=20261124T080000Z;INTERVAL=1;BYDAY=TU;WKST=MO
EXDATE;TZID=W. Europe Standard Time:20261027T090000
UID:040000008200E00074C5B7101A82E00800000000D0E5B8E2A1C3DC01000000000000000
 010000000AB12CD34EF56AB78CD90EF12AB34CD56
SUMMARY;LANGUAGE=de-CH:Teamsitzung
DTSTART;TZID=W. Europe Standard Time:20261006T090000
DTEND;TZID=W. Europe Standard Time:20261006T100000
CLASS:PUBLIC
PRIORITY:5
DTSTAMP:20261012T120000Z
TRANSP:OPAQUE
STATUS:CONFIRMED
SEQUENCE:0
LOCATION;LANGUAGE=de-CH:Sitzungszimmer 2
X-MICROSOFT-CDO-APPT-SEQUENCE:0
X-MICROSOFT-CDO-BUSYSTATUS:BUSY
X-MICROSOFT-CDO-INTENDEDSTATUS:BUSY
X-MICROSOFT-CDO-ALLDAYEVENT:FALSE
X-MICROSOFT-CDO-IMPORTANCE:1
X-MICROSOFT-CDO-INSTTYPE:1
X-MICROSOFT-DONOTFORWARDMEETING:FALSE
X-MICROSOFT-DISALLOW-COUNTER:FALSE
BEGIN:VALARM
DESCRIPTION:REMINDER
TRIGGER;RELATED=START:-PT15M
ACTION:DISPLAY
END:VALARM
END:VEVENT
BEGIN:VEVENT
DESCRIPTION:\\n
UID:040000008200E00074C5B7101A82E00800000000D0E5B8E2A1C3DC01000000000000000
 010000000AB12CD34EF56AB78CD90EF12AB34CD56
RECURRENCE-ID;TZID=W. Europe Standard Time:20261020T090000
SUMMARY;LANGUAGE=de-CH:Teamsitzung (verschoben)
DTSTART;TZID=W. Europe Standard Time:20261021T140000
DTEND;TZID=W. Europe Standard Time:20261021T150000
CLASS:PUBLIC
STATUS:CONFIRMED
LOCATION;LANGUAGE=de-CH:Sitzungszimmer 1
X-MICROSOFT-CDO-INSTTYPE:3
END:VEVENT
BEGIN:VEVENT
UID:040000008200E00074C5B7101A82E0080000000011111111
SUMMARY;LANGUAGE=de-CH:Arzttermin
DTSTART;TZID=\"Romance Standard Time\":20261014T113000
DTEND;TZID=\"Romance Standard Time\":20261014T123000
CLASS:PRIVATE
LOCATION:Praxis Dr. Muster
DESCRIPTION:Vertraulich
END:VEVENT
BEGIN:VEVENT
UID:040000008200E00074C5B7101A82E0080000000022222222
SUMMARY;LANGUAGE=de-CH:Betriebsausflug
DTSTART;VALUE=DATE:20261016
DTEND;VALUE=DATE:20261017
X-MICROSOFT-CDO-ALLDAYEVENT:TRUE
END:VEVENT
BEGIN:VEVENT
UID:040000008200E00074C5B7101A82E0080000000033333333
SUMMARY;LANGUAGE=de-CH:Call New York
DTSTART;TZID=Eastern Standard Time:20261008T100000
DTEND;TZID=Eastern Standard Time:20261008T103000
END:VEVENT
BEGIN:VEVENT
UID:040000008200E00074C5B7101A82E0080000000044444444
SUMMARY;LANGUAGE=de-CH:Abgesagt: Workshop
DTSTART;TZID=W. Europe Standard Time:20261009T090000
DTEND;TZID=W. Europe Standard Time:20261009T120000
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR
";

    #[test]
    fn outlook_export_with_windows_zones_series_and_exceptions() {
        let events = parse(OUTLOOK_ICS, at(2026, 10, 1, 0, 0), at(2026, 12, 1, 0, 0));
        let list: Vec<(i64, &str)> = events.iter().map(|e| (e.start, e.title.as_str())).collect();
        assert_eq!(
            list,
            vec![
                (ms(2026, 10, 6, 9, 0), "Teamsitzung"),
                (ms(2026, 10, 8, 16, 0), "Call New York"),
                (ms(2026, 10, 13, 9, 0), "Teamsitzung"),
                (ms(2026, 10, 14, 11, 30), "Privat"),
                (ms(2026, 10, 16, 0, 0), "Betriebsausflug"),
                // 20.10. moved to 21.10. 14:00, 27.10. removed by EXDATE
                (ms(2026, 10, 21, 14, 0), "Teamsitzung (verschoben)"),
                // After the switch to winter time: still 09:00 local
                (ms(2026, 11, 3, 9, 0), "Teamsitzung"),
                (ms(2026, 11, 10, 9, 0), "Teamsitzung"),
                (ms(2026, 11, 17, 9, 0), "Teamsitzung"),
                // UNTIL 08:00Z is exactly 09:00 CET – inclusive
                (ms(2026, 11, 24, 9, 0), "Teamsitzung"),
            ]
        );

        let first = &events[0];
        assert_eq!(first.end - first.start, 60 * 60 * 1000);
        assert_eq!(first.location.as_deref(), Some("Sitzungszimmer 2"));
        assert_eq!(
            first.description.as_deref(),
            Some("Wöchentliche Abstimmung\n\nTraktanden folgen.")
        );
        assert!(first.id.contains("040000008200E00074C5B7101A82E008"));

        let moved = &events[5];
        assert_eq!(moved.location.as_deref(), Some("Sitzungszimmer 1"));
        assert_eq!(moved.description, None);

        let private = &events[3];
        assert!(private.private);
        assert_eq!(private.location, None);
        assert_eq!(private.description, None);
        assert_eq!(private.end - private.start, 60 * 60 * 1000);

        let outing = &events[4];
        assert!(outing.all_day);
        assert_eq!(outing.end, ms(2026, 10, 17, 0, 0));

        assert!(events.iter().all(|e| !e.title.contains("Abgesagt")));
    }

    #[test]
    fn windows_zone_names_from_the_contract() {
        for (name, zone) in [
            ("W. Europe Standard Time", chrono_tz::Europe::Zurich),
            ("Central Europe Standard Time", chrono_tz::Europe::Budapest),
            ("Romance Standard Time", chrono_tz::Europe::Paris),
            ("GMT Standard Time", chrono_tz::Europe::London),
            ("Eastern Standard Time", chrono_tz::America::New_York),
            ("Pacific Standard Time", chrono_tz::America::Los_Angeles),
            ("UTC", chrono_tz::UTC),
        ] {
            assert_eq!(resolve_tzid(name), Some(zone), "{name}");
        }
    }

    #[tokio::test]
    async fn fetches_webcal_and_caches_the_file() {
        use axum::routing::get;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let hits = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&hits);
        let app = axum::Router::new()
            .route(
                "/kalender.ics",
                get(move || {
                    counter.fetch_add(1, Ordering::SeqCst);
                    async { format!("\u{feff}{}", OUTLOOK_ICS.replace('\n', "\r\n")) }
                }),
            )
            .route("/login", get(|| async { "<html>Anmelden</html>" }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let client = crate::http::build_client().unwrap();
        let source = |path: &str| CalendarSource {
            url: format!("webcal://{addr}{path}"),
            name: Some("Outlook".into()),
            color: None,
        };
        // webcal:// means https; the test server only speaks http.
        let http_source = |path: &str| CalendarSource {
            url: format!("http://{addr}{path}"),
            ..source(path)
        };
        assert!(normalize_calendar_url(&source("/kalender.ics").url).starts_with("https://"));

        let (from, to) = (at(2026, 10, 1, 0, 0), at(2026, 11, 1, 0, 0));
        for _ in 0..3 {
            let events = fetch_calendar(&client, &http_source("/kalender.ics"), from, to, ZURICH)
                .await
                .unwrap();
            assert_eq!(events.len(), 6);
            assert!(events.iter().all(|e| e.source == "Outlook"));
        }
        assert_eq!(hits.load(Ordering::SeqCst), 1, "served from the cache");

        let err = fetch_calendar(&client, &http_source("/login"), from, to, ZURICH)
            .await
            .unwrap_err();
        assert_eq!(err, "Antwort ist keine Kalenderdatei (ICS)");
        let err = fetch_calendar(&client, &http_source("/fehlt.ics"), from, to, ZURICH)
            .await
            .unwrap_err();
        assert_eq!(err, "HTTP 404");
    }

    #[test]
    fn weekly_rule_with_exdate_override_and_cancellation() {
        let ics = "BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:weekly
DTSTART;TZID=Europe/Zurich:20260907T080000
DTEND;TZID=Europe/Zurich:20260907T083000
RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261102T070000Z
EXDATE;TZID=Europe/Zurich:20261012T080000
SUMMARY:Wochenstart
END:VEVENT
BEGIN:VEVENT
UID:weekly
RECURRENCE-ID;TZID=Europe/Zurich:20261019T080000
DTSTART;TZID=Europe/Zurich:20261020T100000
DTEND;TZID=Europe/Zurich:20261020T103000
SUMMARY:Wochenstart (verschoben)
END:VEVENT
BEGIN:VEVENT
UID:weekly
RECURRENCE-ID;TZID=Europe/Zurich:20261026T080000
DTSTART;TZID=Europe/Zurich:20261026T080000
STATUS:CANCELLED
SUMMARY:Wochenstart
END:VEVENT
END:VCALENDAR
";
        let events = parse(ics, at(2026, 10, 1, 0, 0), at(2026, 11, 30, 0, 0));
        let starts: Vec<(i64, &str)> = events.iter().map(|e| (e.start, e.title.as_str())).collect();
        assert_eq!(
            starts,
            vec![
                (ms(2026, 10, 5, 8, 0), "Wochenstart"),
                (ms(2026, 10, 20, 10, 0), "Wochenstart (verschoben)"),
                (ms(2026, 11, 2, 8, 0), "Wochenstart"),
            ]
        );
        // 2.11. is after the DST switch: still 08:00 local.
        assert_eq!(events[2].end - events[2].start, 30 * 60 * 1000);
    }

    #[test]
    fn all_day_recurrence_with_date_until_and_floating_times() {
        let ics = "BEGIN:VCALENDAR
VERSION:2.0
X-WR-TIMEZONE:Europe/Zurich
BEGIN:VEVENT
UID:bday
DTSTART;VALUE=DATE:20200310
RRULE:FREQ=YEARLY
SUMMARY:Geburtstag
END:VEVENT
BEGIN:VEVENT
UID:daily
DTSTART:20261024T120000
DURATION:PT1H
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Mittag
END:VEVENT
BEGIN:VEVENT
UID:until-date
DTSTART;VALUE=DATE:20261001
RRULE:FREQ=DAILY;UNTIL=20261003
SUMMARY:Kurs
END:VEVENT
END:VCALENDAR
";
        let events = parse(ics, at(2026, 1, 1, 0, 0), at(2026, 12, 31, 0, 0));
        let birthday: Vec<&CalendarEvent> =
            events.iter().filter(|e| e.title == "Geburtstag").collect();
        assert_eq!(birthday.len(), 1);
        assert_eq!(birthday[0].start, ms(2026, 3, 10, 0, 0));
        assert_eq!(birthday[0].end, ms(2026, 3, 11, 0, 0));

        let lunch: Vec<i64> = events
            .iter()
            .filter(|e| e.title == "Mittag")
            .map(|e| e.start)
            .collect();
        assert_eq!(
            lunch,
            vec![
                ms(2026, 10, 24, 12, 0),
                ms(2026, 10, 25, 12, 0),
                ms(2026, 10, 26, 12, 0)
            ]
        );

        let course = events.iter().filter(|e| e.title == "Kurs").count();
        assert_eq!(course, 3);
    }

    #[test]
    fn broken_rule_falls_back_to_single_event_and_garbage_is_an_error() {
        let ics = "BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:x
DTSTART:20261015T080000Z
RRULE:FREQ=SOMETIMES
SUMMARY:Kaputt
END:VEVENT
END:VCALENDAR
";
        assert_eq!(
            parse(ics, at(2026, 10, 1, 0, 0), at(2026, 11, 1, 0, 0)).len(),
            1
        );
        let garbage = events_from_ics(
            "BEGIN:VCALENDAR\r\nBEGIN:",
            &meta(),
            at(2026, 1, 1, 0, 0),
            at(2026, 2, 1, 0, 0),
            ZURICH,
        );
        assert!(garbage.is_err());
    }

    #[test]
    fn webcal_urls_become_https() {
        assert_eq!(
            normalize_calendar_url("webcal://p01.icloud.com/x.ics"),
            "https://p01.icloud.com/x.ics"
        );
        assert_eq!(normalize_calendar_url("WEBCALS://a/b"), "https://a/b");
        assert_eq!(normalize_calendar_url("https://a/b"), "https://a/b");
        assert_eq!(
            split_until("FREQ=DAILY;UNTIL=20261003;INTERVAL=2"),
            (
                "FREQ=DAILY;INTERVAL=2".to_string(),
                Some("20261003".to_string())
            )
        );
        assert_eq!(
            split_until("FREQ=WEEKLY;ÄÄÄ"),
            ("FREQ=WEEKLY;ÄÄÄ".to_string(), None)
        );
    }
}
