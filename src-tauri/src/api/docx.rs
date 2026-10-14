//! Minimal DOCX writer for minutes export.
//!
//! The Python backend used `python-docx`. This crate has no DOCX dependency and
//! adding one (a full OOXML stack) is not worth it for what is a single,
//! well-defined output: minutes Markdown rendered as headings, bullet lists and
//! paragraphs.
//!
//! A `.docx` is a ZIP holding a handful of XML parts. The minimum Word,
//! LibreOffice, Pages and Google Docs all accept is:
//!
//! ```text
//! [Content_Types].xml
//! _rels/.rels
//! word/document.xml
//! word/_rels/document.xml.rels   (only needed once styles are referenced)
//! word/styles.xml                (only needed once styles are referenced)
//! ```
//!
//! Heading/bullet formatting is applied with *direct* run/paragraph properties
//! rather than named styles, so `styles.xml` can be omitted entirely and Word
//! still shows bold headings and bulleted lists. This keeps the writer to three
//! parts and avoids the classic "Word found unreadable content" failure that a
//! styles.xml mismatch causes.
//!
//! Scope: exactly what `services/minutes.py::markdown_to_docx` emitted — `#`,
//! `##`, `###` headings, `-`/`*` bullets, `1.` numbered items, blank lines and
//! plain paragraphs, with inline `` `code` ``, `**bold**` and `*italic*`
//! markers stripped.

use std::io::Write;

/// Paragraph/character styles used by the generated document.
///
/// Only the styles actually referenced are declared — Word tolerates a short
/// list, and a mismatch between `styles.xml` and the document is the classic
/// cause of "Word found unreadable content". Style IDs (`Heading1`,
/// `ListBullet`, ...) match what python-docx emitted, so downstream tooling
/// that reads those names keeps working.
const STYLES_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="480" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="1F4D78"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720" w:hanging="360"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720" w:hanging="360"/><w:contextualSpacing/></w:pPr></w:style>
</w:styles>"#;

/// Render minutes Markdown to DOCX bytes.
pub fn render_docx(markdown: &str) -> Result<Vec<u8>, String> {
    let body = render_body(markdown);
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>"#
    );

    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"#;

    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;

    let document_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#;

    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let parts: [(&str, &str); 5] = [
        ("[Content_Types].xml", content_types),
        ("_rels/.rels", rels),
        ("word/_rels/document.xml.rels", document_rels),
        ("word/styles.xml", STYLES_XML),
        ("word/document.xml", &document),
    ];
    for (name, content) in parts {
        zip.start_file(name, opts)
            .map_err(|e| format!("zip start {name}: {e}"))?;
        zip.write_all(content.as_bytes())
            .map_err(|e| format!("zip write {name}: {e}"))?;
    }

    let cursor = zip.finish().map_err(|e| format!("zip finish: {e}"))?;
    Ok(cursor.into_inner())
}

/// Build the `<w:body>` content from Markdown lines.
fn render_body(markdown: &str) -> String {
    let mut out = String::new();
    for raw in markdown.replace('\r', "").lines() {
        let line = raw.trim();
        if line.is_empty() {
            // Python added an empty paragraph for blank lines.
            out.push_str("<w:p/>");
            continue;
        }

        if let Some((level, text)) = parse_heading(line) {
            // Reference the named style so Word/LibreOffice/pandoc see a real
            // heading (it shows up in the navigation pane and the TOC), rather
            // than a bold paragraph that only looks like one.
            let style = match level {
                1 => "Heading1",
                2 => "Heading2",
                _ => "Heading3",
            };
            out.push_str(&format!(
                "<w:p><w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr>\
                 <w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                escape_xml(&strip_inline(text))
            ));
            continue;
        }

        if let Some(text) = parse_bullet(line) {
            out.push_str(&format!(
                "<w:p><w:pPr><w:pStyle w:val=\"ListBullet\"/></w:pPr>\
                 <w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                escape_xml(&format!("• {}", strip_inline(text)))
            ));
            continue;
        }

        if let Some((num, text)) = parse_ordered(line) {
            out.push_str(&format!(
                "<w:p><w:pPr><w:pStyle w:val=\"ListNumber\"/></w:pPr>\
                 <w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                escape_xml(&format!("{num}. {}", strip_inline(text)))
            ));
            continue;
        }

        out.push_str(&format!(
            "<w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
            escape_xml(&strip_inline(line))
        ));
    }
    out
}

fn parse_heading(line: &str) -> Option<(usize, &str)> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if (1..=3).contains(&hashes) {
        let rest = line[hashes..].trim_start();
        // Require whitespace after the hashes, as CommonMark does (`#tag`
        // is a paragraph, not a heading).
        if rest.len() < line[hashes..].len() && !rest.is_empty() {
            return Some((hashes, rest));
        }
    }
    None
}

fn parse_bullet(line: &str) -> Option<&str> {
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(marker) {
            return Some(rest.trim());
        }
    }
    None
}

fn parse_ordered(line: &str) -> Option<(String, &str)> {
    let digits: String = line.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let rest = &line[digits.len()..];
    let rest = rest.strip_prefix(". ")?;
    Some((digits, rest.trim()))
}

/// Strip inline Markdown markers (`code`, `**bold**`, `*italic*`).
fn strip_inline(line: &str) -> String {
    let mut out = line.to_string();
    // `code`
    while let (Some(a), Some(b)) = (out.find('`'), out.rfind('`')) {
        if a >= b {
            break;
        }
        let inner = out[a + 1..b].to_string();
        out = format!("{}{}{}", &out[..a], inner, &out[b + 1..]);
    }
    // **bold**
    while let (Some(a), Some(b)) = (out.find("**"), out.rfind("**")) {
        if a >= b {
            break;
        }
        let inner = out[a + 2..b].to_string();
        out = format!("{}{}{}", &out[..a], inner, &out[b + 2..]);
    }
    // *italic* — only when a pair exists beyond the opening marker.
    if let Some(a) = out.find('*') {
        if let Some(b) = out[a + 1..].find('*').map(|i| i + a + 1) {
            let inner = out[a + 1..b].to_string();
            out = format!("{}{}{}", &out[..a], inner, &out[b + 1..]);
        }
    }
    out.trim().to_string()
}

/// Escape text for an XML text node.
fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Control characters are illegal in XML 1.0 and make Word reject
            // the whole document — drop them rather than emit invalid XML.
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_a_readable_zip_with_the_three_required_parts() {
        let bytes = render_docx("# Tiêu đề\n\n- một\n- hai\n\nĐoạn văn.").unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        for name in [
            "[Content_Types].xml",
            "_rels/.rels",
            "word/_rels/document.xml.rels",
            "word/styles.xml",
            "word/document.xml",
        ] {
            assert!(zip.by_name(name).is_ok(), "missing part {name}");
        }
        let mut doc = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("word/document.xml").unwrap(), &mut doc)
            .unwrap();
        assert!(doc.contains("Tiêu đề"));
        assert!(doc.contains("Đoạn văn."));
        // Bullets are rendered with a leading marker, not a named style.
        assert!(doc.contains("• một"));
    }

    #[test]
    fn escapes_xml_metacharacters() {
        assert_eq!(escape_xml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
        assert_eq!(escape_xml("quote\"here"), "quote&quot;here");
    }

    #[test]
    fn strips_inline_markdown_markers() {
        assert_eq!(strip_inline("**bold** text"), "bold text");
        assert_eq!(strip_inline("`code` here"), "code here");
        assert_eq!(strip_inline("*ital*"), "ital");
    }

    #[test]
    fn heading_requires_space_after_hashes() {
        assert_eq!(parse_heading("## Real heading"), Some((2, "Real heading")));
        assert_eq!(parse_heading("#notaheading"), None);
        assert_eq!(parse_heading("#### too deep"), None);
    }

    #[test]
    fn ordered_list_parses_number_and_text() {
        assert_eq!(parse_ordered("1. first"), Some(("1".to_string(), "first")));
        assert_eq!(parse_ordered("no number"), None);
    }

    /// Control characters must never reach the XML — Word rejects the file.
    #[test]
    fn control_characters_are_dropped() {
        assert_eq!(escape_xml("a\u{0}b\u{7}c"), "abc");
        assert_eq!(escape_xml("tab\tkept"), "tab\tkept");
    }
}
