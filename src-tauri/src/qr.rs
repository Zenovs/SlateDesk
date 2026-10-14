//! QR codes as compact SVG. The modules use `fill="currentColor"` on a transparent background,
//! so CSS themes the code. Own path output instead of the crate's renderer: that one has a
//! fixed four-module quiet zone, the kiosk dialog needs two.

use qrcode::{Color, EcLevel, QrCode};
use std::fmt::Write;

const QUIET_ZONE: usize = 2;
const MAX_TEXT_BYTES: usize = 1024;
/// Intrinsic size (used as `<img>`): whole pixels per module, at least this wide.
const MIN_DIMENSION: usize = 200;

pub fn render_svg(text: &str) -> Result<String, String> {
    if text.is_empty() {
        return Err("Kein Text für den QR-Code".to_string());
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err("Text zu lang für einen QR-Code".to_string());
    }
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M)
        .map_err(|e| format!("QR-Code konnte nicht erzeugt werden: {e}"))?;
    let width = code.width();
    let colors = code.to_colors();
    let size = width + 2 * QUIET_ZONE;

    // One horizontal run per path segment keeps the SVG small.
    let mut path = String::new();
    for (y, row) in colors.chunks(width).enumerate() {
        let mut x = 0;
        while x < width {
            if row[x] != Color::Dark {
                x += 1;
                continue;
            }
            let start = x;
            while x < width && row[x] == Color::Dark {
                x += 1;
            }
            let run = x - start;
            let _ = write!(
                path,
                "M{},{}h{run}v1h-{run}z",
                start + QUIET_ZONE,
                y + QUIET_ZONE
            );
        }
    }

    let pixels = size * MIN_DIMENSION.div_ceil(size);
    Ok(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{pixels}\" height=\"{pixels}\" viewBox=\"0 0 {size} {size}\" shape-rendering=\"crispEdges\"><path fill=\"currentColor\" d=\"{path}\"/></svg>"
    ))
}

#[tauri::command]
pub async fn qr_svg(text: String) -> Result<String, String> {
    render_svg(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_themeable_svg_with_quiet_zone() {
        let svg = render_svg("http://192.168.1.20:7380").unwrap();
        assert!(svg.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""));
        assert!(svg.contains("fill=\"currentColor\""));
        // Version 2 (25 modules) plus 2 quiet modules per side.
        assert!(svg.contains("viewBox=\"0 0 29 29\""), "{svg}");
        // 7 px per module: the smallest whole size of at least 200 px.
        assert!(svg.contains("width=\"203\" height=\"203\""), "{svg}");
        assert!(!svg.contains("<rect"), "background must stay transparent");
        // The finder pattern starts at the quiet zone edge.
        assert!(svg.contains("M2,2h7v1h-7z"));
    }

    #[test]
    fn rejects_empty_and_oversized_text() {
        assert!(render_svg("").is_err());
        assert!(render_svg(&"x".repeat(MAX_TEXT_BYTES + 1)).is_err());
    }
}
