//! RSS/Atom feeds (feed-rs) for the news widgets: fetched in parallel, merged, deduplicated
//! and reduced to plain text.

use crate::http::{describe_error, parse_web_url, read_body_limited, HttpClient};
use feed_rs::model::{Entry, Text};
use futures_util::future::join_all;
use reqwest::header::ACCEPT;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::Duration;
use tauri::State;

const DEFAULT_MAX_ITEMS: usize = 50;
const MAX_ITEMS_CAP: usize = 500;
const MAX_FEEDS: usize = 32;
const FEED_TIMEOUT: Duration = Duration::from_secs(10);
const FEED_MAX_BYTES: usize = 5 * 1024 * 1024;
const SUMMARY_MAX_CHARS: usize = 400;

#[derive(Debug, Clone, Deserialize)]
pub struct FeedSource {
    url: String,
    name: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    id: String,
    title: String,
    link: String,
    summary: Option<String>,
    published: Option<i64>,
    source: String,
    image_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FeedError {
    url: String,
    error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FeedsResult {
    items: Vec<FeedItem>,
    errors: Vec<FeedError>,
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------

fn named_entity(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "ndash" => '–',
        "mdash" => '—',
        "hellip" => '…',
        "laquo" => '«',
        "raquo" => '»',
        "lsquo" => '‘',
        "rsquo" => '’',
        "ldquo" => '“',
        "rdquo" => '”',
        "bdquo" => '„',
        "sbquo" => '‚',
        "auml" => 'ä',
        "ouml" => 'ö',
        "uuml" => 'ü',
        "Auml" => 'Ä',
        "Ouml" => 'Ö',
        "Uuml" => 'Ü',
        "szlig" => '\u{df}',
        "eacute" => 'é',
        "egrave" => 'è',
        "ecirc" => 'ê',
        "agrave" => 'à',
        "aacute" => 'á',
        "ccedil" => 'ç',
        "ocirc" => 'ô',
        "euro" => '€',
        "copy" => '©',
        "reg" => '®',
        "deg" => '°',
        "middot" => '·',
        "bull" => '•',
        "times" => '×',
        _ => return None,
    })
}

pub fn decode_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        let decoded = tail[1..]
            .find(';')
            .filter(|end| *end <= 10)
            .and_then(|end| {
                let name = &tail[1..=end];
                let ch = if let Some(num) =
                    name.strip_prefix("#x").or_else(|| name.strip_prefix("#X"))
                {
                    u32::from_str_radix(num, 16).ok().and_then(char::from_u32)
                } else if let Some(num) = name.strip_prefix('#') {
                    num.parse::<u32>().ok().and_then(char::from_u32)
                } else {
                    named_entity(name)
                };
                ch.map(|c| (c, end + 2))
            });
        match decoded {
            Some((ch, len)) => {
                out.push(ch);
                rest = &tail[len..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn collapse_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Drops tags (and the content of script/style), decodes entities, collapses whitespace.
pub fn html_to_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let tag = &rest[start..];
        let Some(end) = tag.find('>') else {
            // A lone '<' is text, not markup.
            out.push_str(tag);
            rest = "";
            break;
        };
        let name: String = tag[1..end]
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        rest = &tag[end + 1..];
        if (name == "script" || name == "style") && !tag[1..].starts_with('/') {
            let closing = format!("</{name}");
            let lower = rest.to_ascii_lowercase();
            rest = match lower.find(&closing) {
                Some(close) => rest[close..]
                    .find('>')
                    .map_or("", |gt| &rest[close + gt + 1..]),
                None => "",
            };
        }
        if matches!(
            name.as_str(),
            "br" | "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
        ) {
            out.push(' ');
        }
    }
    out.push_str(rest);
    collapse_whitespace(&decode_entities(&out))
}

/// Feeds routinely put markup or entities into "plain" titles, so every text is cleaned.
fn text_content(text: &Text) -> String {
    html_to_text(&text.content)
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head);
    format!("{}…", cut.trim_end_matches([',', ';', ':', '.', '-', ' ']))
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

fn is_image_url(url: &str) -> bool {
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg"]
        .iter()
        .any(|ext| path.ends_with(ext))
}

/// Absolute http(s) URL, resolving relative references against `base`.
fn absolute_url(raw: &str, base: Option<&Url>) -> Option<String> {
    let raw = decode_entities(raw.trim());
    let url = match Url::parse(&raw) {
        Ok(url) => url,
        Err(_) => base?.join(&raw).ok()?,
    };
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

fn first_img_src(html: &str) -> Option<&str> {
    let lower = html.to_ascii_lowercase();
    let img = lower.find("<img")?;
    let src = img + lower[img..].find("src=")? + 4;
    let quote = html[src..].chars().next()?;
    if quote == '"' || quote == '\'' {
        let value = &html[src + 1..];
        value.find(quote).map(|end| &value[..end])
    } else {
        html[src..].split([' ', '>']).next()
    }
}

fn entry_link(entry: &Entry) -> Option<String> {
    let preferred = entry
        .links
        .iter()
        .find(|l| l.rel.as_deref().is_none_or(|rel| rel == "alternate"))
        .or_else(|| {
            entry
                .links
                .iter()
                .find(|l| l.rel.as_deref() != Some("enclosure"))
        });
    preferred
        .map(|l| l.href.clone())
        .or_else(|| entry.id.starts_with("http").then(|| entry.id.clone()))
}

fn entry_image(entry: &Entry, base: Option<&Url>) -> Option<String> {
    let from_media = entry.media.iter().find_map(|media| {
        media
            .thumbnails
            .first()
            .map(|t| t.image.uri.clone())
            .or_else(|| {
                media.content.iter().find_map(|c| {
                    let url = c.url.as_ref()?.to_string();
                    let image_type = c
                        .content_type
                        .as_ref()
                        .is_some_and(|t| t.ty().as_str() == "image");
                    (image_type || is_image_url(&url)).then_some(url)
                })
            })
    });
    let from_enclosure = || {
        entry
            .links
            .iter()
            .find(|l| {
                l.rel.as_deref() == Some("enclosure")
                    && (l
                        .media_type
                        .as_deref()
                        .is_some_and(|t| t.starts_with("image/"))
                        || is_image_url(&l.href))
            })
            .map(|l| l.href.clone())
    };
    let from_html = || {
        let content = entry.content.as_ref().and_then(|c| c.body.as_deref());
        let summary = entry.summary.as_ref().map(|s| s.content.as_str());
        [content, summary]
            .into_iter()
            .flatten()
            .find_map(first_img_src)
            .map(str::to_string)
    };
    from_media
        .or_else(from_enclosure)
        .or_else(from_html)
        .and_then(|raw| absolute_url(&raw, base))
}

/// URL- or URN-like guids are global; short ones ("123") only within their feed, so two
/// feeds with numeric guids neither collide in the dedupe nor as list keys.
fn item_id(guid: &str, source: &str) -> String {
    let guid = guid.trim();
    let global = guid.contains("://")
        || ["urn:", "tag:"].iter().any(|prefix| {
            guid.len() > prefix.len()
                && guid
                    .get(..prefix.len())
                    .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        });
    if global {
        guid.to_string()
    } else {
        format!("{source}#{guid}")
    }
}

fn entry_to_item(entry: &Entry, source: &str, base: Option<&Url>) -> Option<FeedItem> {
    let title = entry
        .title
        .as_ref()
        .map(text_content)
        .filter(|t| !t.is_empty())?;
    let summary = entry
        .summary
        .as_ref()
        .map(text_content)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            entry
                .content
                .as_ref()
                .and_then(|c| c.body.as_deref())
                .map(html_to_text)
                .filter(|s| !s.is_empty())
        })
        .map(|s| truncate_chars(&s, SUMMARY_MAX_CHARS))
        .filter(|s| *s != title);
    let link = entry_link(entry)
        .and_then(|l| absolute_url(&l, base))
        .unwrap_or_default();
    Some(FeedItem {
        id: item_id(&entry.id, source),
        title,
        link,
        summary,
        published: entry
            .published
            .or(entry.updated)
            .map(|d| d.timestamp_millis()),
        source: source.to_string(),
        image_url: entry_image(entry, base),
    })
}

/// feed-rs drops a `media:thumbnail` that is not paired with `media:content`, yet many news
/// feeds use exactly that. Returns the first such URL per `<item>`/`<entry>`, in order.
fn standalone_thumbnails(xml: &str) -> Vec<Option<String>> {
    let starts: Vec<usize> = xml
        .match_indices("<item")
        .chain(xml.match_indices("<entry"))
        .filter(|(pos, tag)| {
            xml[pos + tag.len()..]
                .chars()
                .next()
                .is_some_and(|c| c == '>' || c.is_whitespace())
        })
        .map(|(pos, _)| pos)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    starts
        .iter()
        .enumerate()
        .map(|(i, start)| {
            let end = starts.get(i + 1).copied().unwrap_or(xml.len());
            let segment = &xml[*start..end];
            let tag = segment.find("<media:thumbnail")?;
            let attrs = &segment[tag..tag + segment[tag..].find('>')?];
            let url = attrs.find("url=")? + 4;
            let quote = attrs[url..]
                .chars()
                .next()
                .filter(|q| *q == '"' || *q == '\'')?;
            let value = &attrs[url + 1..];
            value.find(quote).map(|close| value[..close].to_string())
        })
        .collect()
}

/// Parses one feed document into items.
pub fn parse_feed(bytes: &[u8], url: &Url, name: Option<&str>) -> Result<Vec<FeedItem>, String> {
    let feed = feed_rs::parser::Builder::new()
        .base_uri(Some(url.as_str()))
        .build()
        .parse(bytes)
        .map_err(|e| format!("Feed nicht lesbar: {e}"))?;
    let source = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .or_else(|| {
            feed.title
                .as_ref()
                .map(text_content)
                .filter(|t| !t.is_empty())
        })
        .unwrap_or_else(|| url.host_str().unwrap_or("Feed").to_string());
    let thumbnails = std::str::from_utf8(bytes)
        .ok()
        .map(standalone_thumbnails)
        .filter(|found| found.len() == feed.entries.len())
        .unwrap_or_default();
    Ok(feed
        .entries
        .iter()
        .enumerate()
        .filter_map(|(i, entry)| {
            let mut item = entry_to_item(entry, &source, Some(url))?;
            if item.image_url.is_none() {
                item.image_url = thumbnails
                    .get(i)
                    .and_then(Option::as_deref)
                    .and_then(|raw| absolute_url(raw, Some(url)));
            }
            Some(item)
        })
        .collect())
}

fn normalized_title(title: &str) -> String {
    title
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Newest first; the same story (guid or title) only once.
pub fn merge_items(lists: Vec<Vec<FeedItem>>, max_items: usize) -> Vec<FeedItem> {
    let mut items: Vec<FeedItem> = lists.into_iter().flatten().collect();
    items.sort_by(|a, b| {
        b.published
            .unwrap_or(i64::MIN)
            .cmp(&a.published.unwrap_or(i64::MIN))
    });
    let mut seen_ids = HashSet::new();
    let mut seen_titles = HashSet::new();
    items.retain(|item| {
        let title = normalized_title(&item.title);
        let new_id = seen_ids.insert(item.id.clone());
        let new_title = title.is_empty() || seen_titles.insert(title);
        new_id && new_title
    });
    items.truncate(max_items);
    items
}

async fn fetch_feed(client: &Client, source: &FeedSource) -> Result<Vec<FeedItem>, String> {
    let url = parse_web_url(&source.url)?;
    let response = client
        .get(url.clone())
        .header(
            ACCEPT,
            "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
        )
        .timeout(FEED_TIMEOUT)
        .send()
        .await
        .map_err(|e| describe_error(&e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    let body = read_body_limited(response, FEED_MAX_BYTES).await?;
    let name = source.name.clone();
    tokio::task::spawn_blocking(move || parse_feed(&body, &url, name.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn feeds_fetch(
    feeds: Vec<FeedSource>,
    max_items: Option<usize>,
    http: State<'_, HttpClient>,
) -> Result<FeedsResult, String> {
    if feeds.len() > MAX_FEEDS {
        return Err(format!("Zu viele Feeds (maximal {MAX_FEEDS})"));
    }
    let max_items = max_items
        .unwrap_or(DEFAULT_MAX_ITEMS)
        .clamp(1, MAX_ITEMS_CAP);
    let results = join_all(feeds.iter().map(|source| fetch_feed(&http.0, source))).await;

    let mut lists = Vec::new();
    let mut errors = Vec::new();
    for (source, result) in feeds.iter().zip(results) {
        match result {
            Ok(items) => lists.push(items),
            Err(error) => errors.push(FeedError {
                url: source.url.clone(),
                error,
            }),
        }
    }
    Ok(FeedsResult {
        items: merge_items(lists, max_items),
        errors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Beispiel &amp; Co.</title>
    <link>https://news.example.ch/</link>
    <item>
      <title>Zweite &lt;b&gt;Meldung&lt;/b&gt;</title>
      <link>https://news.example.ch/2</link>
      <guid>n-2</guid>
      <pubDate>Tue, 13 Oct 2026 09:00:00 +0200</pubDate>
      <description><![CDATA[<p>Text mit <a href="x">Link</a> &amp; mehr<script>alert(1)</script></p><img src="/bilder/2.jpg">]]></description>
    </item>
    <item>
      <title>Erste Meldung</title>
      <link>https://news.example.ch/1</link>
      <guid>n-1</guid>
      <pubDate>Mon, 12 Oct 2026 09:00:00 +0200</pubDate>
      <media:thumbnail url="https://cdn.example.ch/1.jpg"/>
    </item>
  </channel>
</rss>"#;

    const ATOM: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Quelle</title>
  <id>urn:atom</id>
  <updated>2026-10-13T10:00:00Z</updated>
  <entry>
    <title>ERSTE Meldung!</title>
    <id>urn:a1</id>
    <link rel="alternate" href="https://atom.example.ch/a1"/>
    <updated>2026-10-13T10:00:00Z</updated>
    <summary>Kurz</summary>
  </entry>
</feed>"#;

    #[test]
    fn html_is_reduced_to_text() {
        assert_eq!(
            html_to_text("<p>Hallo&nbsp;<b>Welt</b></p><p>Zwei</p>"),
            "Hallo Welt Zwei"
        );
        assert_eq!(html_to_text("a<script>var x = '<p>';</script>b"), "ab");
        assert_eq!(html_to_text("3 < 4 &amp; 5 &gt; 2"), "3 < 4 & 5 > 2");
        assert_eq!(
            decode_entities("&#228;&#xFC;&unbekannt;&"),
            "äü&unbekannt;&"
        );
        assert_eq!(truncate_chars("eins zwei drei", 9), "eins…");
    }

    #[test]
    fn parses_rss_with_images_and_text() {
        let url = Url::parse("https://news.example.ch/feed.xml").unwrap();
        let items = parse_feed(RSS.as_bytes(), &url, None).unwrap();
        assert_eq!(items.len(), 2);
        let second = &items[0];
        assert_eq!(second.title, "Zweite Meldung");
        assert_eq!(second.source, "Beispiel & Co.");
        assert_eq!(second.link, "https://news.example.ch/2");
        assert_eq!(second.summary.as_deref(), Some("Text mit Link & mehr"));
        assert_eq!(
            second.image_url.as_deref(),
            Some("https://news.example.ch/bilder/2.jpg")
        );
        assert!(second.published.is_some());
        assert_eq!(
            items[1].image_url.as_deref(),
            Some("https://cdn.example.ch/1.jpg")
        );
    }

    #[test]
    fn merges_dedupes_and_sorts() {
        let rss = parse_feed(
            RSS.as_bytes(),
            &Url::parse("https://news.example.ch/feed.xml").unwrap(),
            Some("News"),
        )
        .unwrap();
        let atom = parse_feed(
            ATOM.as_bytes(),
            &Url::parse("https://atom.example.ch/feed").unwrap(),
            None,
        )
        .unwrap();
        assert_eq!(atom[0].source, "Atom Quelle");
        let merged = merge_items(vec![rss.clone(), atom, rss], 10);
        let titles: Vec<&str> = merged.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(titles, vec!["ERSTE Meldung!", "Zweite Meldung"]);
        assert_eq!(merge_items(vec![merged], 1).len(), 1);
    }

    #[test]
    fn short_guids_are_scoped_to_their_feed() {
        let item = |id: &str, title: &str, source: &str| FeedItem {
            id: item_id(id, source),
            title: title.into(),
            link: String::new(),
            summary: None,
            published: Some(1),
            source: source.into(),
            image_url: None,
        };
        assert_eq!(item_id("123", "SRF"), "SRF#123");
        assert_eq!(
            item_id("https://www.srf.ch/news/1", "SRF"),
            "https://www.srf.ch/news/1"
        );
        assert_eq!(item_id("urn:uuid:1", "A"), "urn:uuid:1");
        assert_eq!(item_id("ürn", "A"), "A#ürn");
        let merged = merge_items(
            vec![
                vec![item("123", "Wetter morgen", "A")],
                vec![item("123", "Börse aktuell", "B")],
                vec![
                    item("https://x.ch/1", "Eins", "A"),
                    item("https://x.ch/1", "Eins neu", "B"),
                ],
            ],
            10,
        );
        assert_eq!(merged.len(), 3);
    }

    #[test]
    fn broken_feed_is_an_error() {
        let url = Url::parse("https://x.example.ch/").unwrap();
        assert!(parse_feed(b"<html>kein feed</html>", &url, None).is_err());
    }
}
