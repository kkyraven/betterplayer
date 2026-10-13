use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use crate::axis::Axis;
use crate::funscript::{MAX_ACTIONS, MAX_SCRIPT_BYTES, Raw, Script};

const MAX_ZIP_BYTES: usize = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 1_024;
const MAX_LOAD_BYTES: usize = 128 * 1024 * 1024;
const MAX_LOAD_ACTIONS: usize = 2 * MAX_ACTIONS;
const MAX_DIRECTORY_ENTRIES: usize = 16_384;
const MAX_SCRIPT_FILES: usize = 256;
const MAX_SCRIPT_FOLDERS: usize = 32;
const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mkv", "mk3d", "webm", "mov", "avi", "divx", "wmv", "asf",
    "ts", "m2ts", "mts", "mpg", "mpeg", "m2v", "vob", "flv", "f4v", "3gp",
    "3g2", "ogv", "ogm", "mxf", "dv", "rm", "rmvb", "wtv", "ivf", "h264",
    "264", "hevc", "h265", "265",
];

struct LoadBudget {
    bytes: usize,
    compressed_bytes: usize,
    actions: usize,
    directory_entries: usize,
    files: usize,
}

impl Default for LoadBudget {
    fn default() -> Self {
        Self { bytes: MAX_LOAD_BYTES, compressed_bytes: MAX_ZIP_BYTES, actions: MAX_LOAD_ACTIONS, directory_entries: MAX_DIRECTORY_ENTRIES, files: MAX_SCRIPT_FILES }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Container {
    Sibling,
    Zip,
    Axes,
    Channels,
}

impl Container {
    pub fn as_str(self) -> &'static str {
        match self {
            Container::Sibling => "sibling",
            Container::Zip => "zip",
            Container::Axes => "axes",
            Container::Channels => "channels",
        }
    }
}

#[derive(Clone, Debug)]
pub struct LoadedScript {
    pub axis: Axis,
    pub variant: Option<String>,
    pub source: PathBuf,
    pub container: Container,
    pub script: Script,
    pub multi_axis: Option<Script>,
}

impl LoadedScript {
    pub fn script_for(&self, multi_axis: bool) -> &Script {
        if multi_axis { self.multi_axis.as_ref().unwrap_or(&self.script) } else { &self.script }
    }
}

pub fn find_scripts(media: &Path) -> Vec<LoadedScript> {
    find_scripts_in(media, &mut LoadBudget::default())
}

fn find_scripts_in(media: &Path, budget: &mut LoadBudget) -> Vec<LoadedScript> {
    let Some(stem) = media.file_stem().and_then(|s| s.to_str()) else { return Vec::new() };
    let dir = media.parent().unwrap_or(Path::new("."));
    let mut found: BTreeMap<(Axis, u8, String), LoadedScript> = BTreeMap::new();
    let mut add = |s: LoadedScript| {
        if !s.script.is_empty() {
            let key = (s.axis, s.variant.is_some() as u8, s.variant.clone().unwrap_or_default());
            found.entry(key).or_insert(s);
        }
    };

    let mut siblings = Vec::new();
    let mut zips = Vec::new();
    let mut video_stems = BTreeSet::new();
    let mut directory_complete = true;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.take(budget.directory_entries) {
            budget.directory_entries -= 1;
            let Ok(entry) = entry else { directory_complete = false; continue };
            let path = entry.path();
            if !path.is_file() { continue; }
            if VIDEO_EXTENSIONS.iter().any(|extension| has_extension(&path, extension)) {
                if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                    video_stems.insert(name.to_string());
                }
                continue;
            }
            if suffix_for(&path, stem).is_some() {
                siblings.push(path);
            } else if path.file_stem().and_then(|s| s.to_str()) == Some(stem) && has_extension(&path, "zip") {
                zips.push(path);
            }
        }
    } else { directory_complete = false; }
    directory_complete &= budget.directory_entries > 0;
    siblings.sort();
    for path in siblings.into_iter()
        .filter(|path| !belongs_to_other_video(path, stem, &video_stems, directory_complete))
        .take(budget.files)
    {
        budget.files -= 1;
        let Ok(mut file) = fs::File::open(&path) else { continue };
        if file.metadata().is_ok_and(|m| m.len() > MAX_SCRIPT_BYTES as u64) { continue; }
        let Some(text) = read_script(&mut file, budget) else { continue };
        for s in parse_any(&text, &path, suffix_for(&path, stem).unwrap_or_default(), budget).into_iter().flatten() {
            add(s);
        }
    }

    zips.sort();
    for zip_path in zips {
        if budget.files == 0 || budget.bytes == 0 || budget.actions == 0 { break; }
        budget.files -= 1;
        for s in read_zip(&zip_path, stem, budget) {
            add(s);
        }
    }
    found.into_values().collect()
}

pub fn find_scripts_with_folders(media: &Path, folders: &[String]) -> Vec<LoadedScript> {
    let mut budget = LoadBudget::default();
    let mut scripts = find_scripts_in(media, &mut budget);
    let Some(name) = media.file_name() else { return scripts };
    for folder in folders.iter().take(MAX_SCRIPT_FOLDERS) {
        let axes: Vec<Axis> = scripts.iter().map(|s| s.axis).collect();
        scripts.extend(find_scripts_in(&Path::new(folder).join(name), &mut budget).into_iter().filter(|s| !axes.contains(&s.axis)));
    }
    scripts.sort_by_key(|s| s.axis);
    scripts
}

fn suffix_for(path: &Path, stem: &str) -> Option<String> {
    if !has_extension(path, "funscript") { return None; }
    let name = path.file_stem()?.to_str()?;
    let rest = name.strip_prefix(stem)?;
    if rest.is_empty() {
        return Some(String::new());
    }
    if let Some(inner) = rest.strip_prefix(" (").and_then(|r| r.strip_suffix(')')) {
        return (!inner.is_empty()).then(|| inner.to_string());
    }
    if let Some(inner) = rest.strip_prefix('-') {
        let variant = inner.split('.').next()?.to_ascii_lowercase();
        if variant == "max" || variant == "plus" { return Some(inner.to_string()); }
    }
    rest.strip_prefix(['.', '_']).map(str::to_string)
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case(extension))
}

fn belongs_to_other_video(path: &Path, stem: &str, video_stems: &BTreeSet<String>, directory_complete: bool) -> bool {
    let Some(name) = path.file_stem().and_then(|s| s.to_str()) else { return false };
    let hyphen_variant = name.split('.').any(|part| part.rsplit_once('-').is_some_and(|(_, suffix)| {
        suffix.eq_ignore_ascii_case("max") || suffix.eq_ignore_ascii_case("plus")
    }));
    if !hyphen_variant { return false; }
    let Some(rest) = name.strip_prefix(stem) else { return false };
    if rest.is_empty() { return false; }
    if rest.starts_with('-') && !directory_complete { return true; }
    if video_stems.contains(name) { return true; }
    name.char_indices().any(|(index, separator)| {
        index > stem.len() && matches!(separator, '.' | '_' | '-' | ' ')
            && video_stems.contains(&name[..index]) && suffix_for(path, &name[..index]).is_some()
    })
}

pub fn classify_suffix(suffix: &str) -> (Axis, Option<String>) {
    let parts: Vec<&str> = suffix.split('.').filter(|p| !p.is_empty()).collect();
    let mut axis = None;
    let mut rest: Vec<String> = Vec::new();
    for part in &parts {
        let lower = part.to_ascii_lowercase();
        if axis.is_none() {
            if let Some(a) = Axis::from_suffix(&lower) {
                axis = Some(a);
                continue;
            }
            let base = lower.trim_end_matches(|c: char| c.is_ascii_digit());
            let digits = &lower[base.len()..];
            if !digits.is_empty() {
                if matches!(base, "vib" | "vibe" | "vibrate") {
                    axis = Some(if digits == "2" { Axis::V1 } else { Axis::V0 });
                    continue;
                }
                if let Some(a) = Axis::from_suffix(base) {
                    axis = Some(a);
                    rest.push(digits.to_string());
                    continue;
                }
            }
            if matches!(lower.as_str(), "vibe" | "vibrate") {
                axis = Some(Axis::V0);
                continue;
            }
        }
        rest.push(part.to_string());
    }
    let variant = (!rest.is_empty()).then(|| rest.join("."));
    (axis.unwrap_or(Axis::L0), variant)
}

pub fn select_default(scripts: &[LoadedScript]) -> Vec<&LoadedScript> {
    let mut out: Vec<&LoadedScript> = Vec::new();
    for s in scripts {
        if !out.iter().any(|o| o.axis == s.axis) {
            out.push(s);
        }
    }
    out
}

fn parse_any(text: &str, source: &Path, suffix: String, budget: &mut LoadBudget) -> Option<Vec<LoadedScript>> {
    let raw = Raw::parse(text).ok()?;
    let action_count = raw.action_count();
    if action_count > budget.actions {
        budget.actions = 0;
        return None;
    }
    budget.actions -= action_count;
    let mut out = Vec::new();
    let (file_axis, variant) = if suffix.is_empty() { (Axis::L0, None) } else { classify_suffix(&suffix) };
    let Raw { actions, inverted, metadata, axes, channels } = raw;
    let container = if channels.is_some() { Container::Channels } else if axes.is_some() { Container::Axes } else { Container::Sibling };
    let root = Script::from_raw(actions, inverted, metadata);
    out.push(LoadedScript { axis: file_axis, variant: variant.clone(), source: source.into(), container, script: root, multi_axis: None });
    let mut bundled = BTreeMap::new();
    if let Some(axes) = axes {
        for a in axes {
            if let Some(axis) = Axis::from_id(&a.id).or_else(|| Axis::from_suffix(&a.id)) {
                bundled.insert(axis, Script::from_raw(a.actions, a.inverted, None));
            }
        }
    }
    if let Some(channels) = channels {
        for (name, ch) in channels {
            if let Some(axis) = Axis::from_suffix(&name).or_else(|| Axis::from_id(&name)) {
                bundled.insert(axis, Script::from_raw(ch.actions, ch.inverted, None));
            }
        }
    }
    for (axis, mut script) in bundled {
        if script.is_empty() { continue; }
        script.metadata = out[0].script.metadata.clone();
        script.chapters = out[0].script.chapters.clone();
        script.bookmarks = out[0].script.bookmarks.clone();
        if let Some(existing) = out.iter_mut().find(|s| s.axis == axis) {
            if existing.script.is_empty() {
                existing.script = script;
            } else {
                existing.multi_axis = Some(script);
            }
        } else {
            out.push(LoadedScript { axis, variant: variant.clone(), source: source.into(), container, script, multi_axis: None });
        }
    }
    Some(out)
}

fn read_script(reader: &mut impl Read, budget: &mut LoadBudget) -> Option<String> {
    let limit = MAX_SCRIPT_BYTES.min(budget.bytes);
    let mut bytes = Vec::new();
    let result = reader.take(limit as u64 + 1).read_to_end(&mut bytes);
    budget.bytes = budget.bytes.saturating_sub(bytes.len());
    if result.is_err() || bytes.len() > limit { return None; }
    String::from_utf8(bytes).ok()
}

fn zip_directory_within_limit(bytes: &[u8]) -> bool {
    let start = bytes.len().saturating_sub(22 + usize::from(u16::MAX));
    for offset in (start..bytes.len().saturating_sub(21)).rev() {
        let header = &bytes[offset..offset + 22];
        if header[..4] != *b"PK\x05\x06" { continue; }
        let comment_len = usize::from(u16::from_le_bytes([header[20], header[21]]));
        if offset + 22 + comment_len != bytes.len() { continue; }
        let on_disk = u16::from_le_bytes([header[8], header[9]]);
        let total = u16::from_le_bytes([header[10], header[11]]);
        if header[4..8] != [0, 0, 0, 0] || on_disk != total || usize::from(total) > MAX_ZIP_ENTRIES { return false; }
        let size = u32::from_le_bytes(header[12..16].try_into().unwrap());
        let directory_offset = u32::from_le_bytes(header[16..20].try_into().unwrap());
        if size == u32::MAX || directory_offset == u32::MAX || u64::from(directory_offset) + u64::from(size) > offset as u64 { return false; }
        if offset >= 20 && bytes[offset - 20..offset - 16] == *b"PK\x06\x07" { return false; }
        return true;
    }
    false
}

fn zip_suffix(inner: &Path, stem: &str) -> Option<String> {
    if let Some(suffix) = suffix_for(inner, stem) { return Some(suffix); }
    if !has_extension(inner, "funscript") { return None; }
    let name = inner.file_stem()?.to_str()?;
    if Axis::from_suffix(name).or_else(|| Axis::from_id(name)).is_some() { return Some(name.to_string()); }
    Some(name.split_once('.').map(|(_, rest)| rest).unwrap_or("").to_string())
}

fn read_zip(zip_path: &Path, stem: &str, budget: &mut LoadBudget) -> Vec<LoadedScript> {
    let mut out = Vec::new();
    let Ok(file) = fs::File::open(zip_path) else { return out };
    let compressed_limit = MAX_ZIP_BYTES.min(budget.compressed_bytes);
    if file.metadata().is_ok_and(|m| m.len() > compressed_limit as u64) { return out; }
    let mut bytes = Vec::new();
    let result = file.take(compressed_limit as u64 + 1).read_to_end(&mut bytes);
    budget.compressed_bytes = budget.compressed_bytes.saturating_sub(bytes.len());
    if result.is_err() || bytes.len() > compressed_limit || !zip_directory_within_limit(&bytes) { return out; }
    let Ok(mut archive) = zip::ZipArchive::new(Cursor::new(bytes)) else { return out };
    if archive.len() > MAX_ZIP_ENTRIES { return out; }
    let mut expanded = 0_u64;
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index(index) else { continue };
        expanded = expanded.saturating_add(entry.size());
        if expanded > budget.bytes as u64 { return Vec::new(); }
        if entry.is_dir() || entry.is_symlink() || entry.encrypted() { continue; }
        let Some(inner) = entry.enclosed_name() else { continue };
        let Some(suffix) = zip_suffix(&inner, stem) else { continue };
        if entry.size() > MAX_SCRIPT_BYTES as u64 { return Vec::new(); }
        entries.push((entry.name().to_string(), index, suffix));
    }
    if entries.len() > budget.files { return Vec::new(); }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (_, index, suffix) in entries {
        budget.files -= 1;
        let Ok(mut entry) = archive.by_index(index) else { continue };
        let Some(text) = read_script(&mut entry, budget) else { return Vec::new() };
        let parsed = parse_any(&text, zip_path, suffix, budget);
        if parsed.is_none() && budget.actions == 0 { return Vec::new(); }
        for mut s in parsed.into_iter().flatten() {
            s.container = Container::Zip;
            out.push(s);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bp-script-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    const ONE: &str = r#"{"actions":[{"at":0,"pos":0},{"at":1000,"pos":100}]}"#;

    #[test]
    fn shock_script_is_separate_from_stroke() {
        let d = tmp("shock-axis");
        fs::write(d.join("film.funscript"), ONE).unwrap();
        fs::write(d.join("film.shock.funscript"), ONE).unwrap();
        let scripts = find_scripts(&d.join("film.mp4"));
        assert_eq!(scripts.iter().map(|s| s.axis).collect::<Vec<_>>(), vec![Axis::L0, Axis::S0]);
        assert_eq!(classify_suffix("SHOCK"), (Axis::S0, None));
        assert_eq!(classify_suffix("alternative.shock"), (Axis::S0, Some("alternative".into())));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn other_folders_fill_missing_axes_without_replacing_siblings() {
        let d = tmp("other-folders");
        let video = d.join("video");
        let first = d.join("first");
        let second = d.join("second");
        for dir in [&video, &first, &second] { fs::create_dir_all(dir).unwrap(); }
        fs::write(video.join("clip.alternative.funscript"), ONE).unwrap();
        fs::write(first.join("clip.funscript"), ONE).unwrap();
        fs::write(first.join("clip.roll.funscript"), ONE).unwrap();
        fs::write(first.join("clip.alternative.roll.funscript"), ONE).unwrap();
        fs::write(second.join("clip.roll.funscript"), ONE).unwrap();
        fs::write(second.join("clip.pitch.funscript"), ONE).unwrap();
        fs::write(second.join("other.twist.funscript"), ONE).unwrap();
        let folders = vec![first.to_string_lossy().into_owned(), second.to_string_lossy().into_owned()];
        let scripts = find_scripts_with_folders(&video.join("clip.mp4"), &folders);
        assert_eq!(scripts.len(), 4);
        assert_eq!(scripts[0].source, video.join("clip.alternative.funscript"));
        assert!(scripts.iter().filter(|s| s.axis == Axis::R1).all(|s| s.source.parent() == Some(first.as_path())));
        assert_eq!(scripts.last().unwrap().source, second.join("clip.pitch.funscript"));
        assert_eq!(select_default(&scripts).len(), 3);
        assert_eq!(find_scripts_with_folders(&video.join("clip.mp4"), &[]).len(), 1);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn unreadable_or_empty_siblings_allow_fallback() {
        let d = tmp("empty-fallback");
        let other = d.join("other");
        fs::create_dir_all(&other).unwrap();
        fs::write(d.join("clip.funscript"), r#"{"actions":[]}"#).unwrap();
        fs::write(other.join("clip.funscript"), ONE).unwrap();
        let scripts = find_scripts_with_folders(&d.join("clip.mp4"), &[other.to_string_lossy().into_owned()]);
        assert_eq!(scripts.len(), 1);
        assert_eq!(scripts[0].source, other.join("clip.funscript"));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn siblings_by_suffix() {
        let d = tmp("sib");
        fs::write(d.join("clip.mp4"), b"").unwrap();
        fs::write(d.join("clip.funscript"), ONE).unwrap();
        fs::write(d.join("clip.roll.funscript"), ONE).unwrap();
        fs::write(d.join("clip.Twist.FUNSCRIPT"), ONE).unwrap();
        fs::write(d.join("clip (1).funscript"), ONE).unwrap();
        fs::write(d.join("other.pitch.funscript"), ONE).unwrap();
        let s = find_scripts(&d.join("clip.mp4"));
        let names: Vec<(Axis, Option<&str>)> = s.iter().map(|x| (x.axis, x.variant.as_deref())).collect();
        assert_eq!(names, vec![(Axis::L0, None), (Axis::L0, Some("1")), (Axis::R0, None), (Axis::R1, None)]);
        assert!(s.iter().all(|x| x.container == Container::Sibling));
    }

    #[test]
    fn underscore_and_parenthesised_variants() {
        let d = tmp("seps");
        fs::write(d.join("v.funscript"), ONE).unwrap();
        fs::write(d.join("v_simple.funscript"), ONE).unwrap();
        fs::write(d.join("v (Less Vibration).funscript"), ONE).unwrap();
        fs::write(d.join("v (roll).funscript"), ONE).unwrap();
        fs::write(d.join("v ().funscript"), ONE).unwrap();
        let s = find_scripts(&d.join("v.mp4"));
        let names: Vec<(Axis, Option<&str>)> = s.iter().map(|x| (x.axis, x.variant.as_deref())).collect();
        assert_eq!(names, vec![(Axis::L0, None), (Axis::L0, Some("Less Vibration")), (Axis::L0, Some("simple")), (Axis::R1, None)]);
    }

    #[test]
    fn suffixes_classify_into_axis_and_variant() {
        assert_eq!(classify_suffix("roll"), (Axis::R1, None));
        assert_eq!(classify_suffix("Stroke1"), (Axis::L0, Some("1".into())));
        assert_eq!(classify_suffix("Vibe1"), (Axis::V0, None));
        assert_eq!(classify_suffix("vib2"), (Axis::V1, None));
        assert_eq!(classify_suffix("mouth"), (Axis::L0, Some("mouth".into())));
        assert_eq!(classify_suffix("alternative.mouth.a"), (Axis::L0, Some("alternative.mouth.a".into())));
        assert_eq!(classify_suffix("alternative.roll"), (Axis::R1, Some("alternative".into())));
        assert_eq!(classify_suffix("MAX"), (Axis::L0, Some("MAX".into())));
        assert_eq!(classify_suffix("alternative.MAX.roll"), (Axis::R1, Some("alternative.MAX".into())));
    }

    #[test]
    fn suffixed_bundle_root_takes_the_file_axis() {
        let d = tmp("bundle-suffix");
        let bundle = r#"{"actions":[{"at":0,"pos":0},{"at":1000,"pos":100}],"axes":[{"id":"V0","actions":[{"at":0,"pos":0},{"at":1000,"pos":100}]}]}"#;
        fs::write(d.join("v.e3.funscript"), bundle).unwrap();
        fs::write(d.join("v.funscript"), ONE).unwrap();
        let s = find_scripts(&d.join("v.mp4"));
        let names: Vec<(Axis, Option<&str>)> = s.iter().map(|x| (x.axis, x.variant.as_deref())).collect();
        assert_eq!(names, vec![(Axis::L0, None), (Axis::V0, None), (Axis::E3, None)]);
    }

    #[test]
    fn variants_are_listed_and_the_plain_one_is_default() {
        let d = tmp("var");
        fs::write(d.join("v.funscript"), ONE).unwrap();
        fs::write(d.join("v.mouth.funscript"), ONE).unwrap();
        fs::write(d.join("v.anal.funscript"), ONE).unwrap();
        fs::write(d.join("v.Vibe1.funscript"), ONE).unwrap();
        let s = find_scripts(&d.join("v.mp4"));
        let names: Vec<(Axis, Option<&str>)> = s.iter().map(|x| (x.axis, x.variant.as_deref())).collect();
        assert_eq!(names, vec![(Axis::L0, None), (Axis::L0, Some("anal")), (Axis::L0, Some("mouth")), (Axis::V0, None)]);
        let picked = select_default(&s);
        assert_eq!(picked.iter().map(|x| (x.axis, x.variant.as_deref())).collect::<Vec<_>>(), vec![(Axis::L0, None), (Axis::V0, None)]);
    }

    #[test]
    fn explicit_hyphen_variants_preserve_plain_default_and_exclude_other_editions() {
        let d = tmp("hyphen-variants");
        fs::write(d.join("v.mp4"), b"").unwrap();
        for name in ["v.funscript", "v-max.funscript", "v-plus.funscript", "v-plus.roll.funscript", "v-other.funscript"] {
            fs::write(d.join(name), ONE).unwrap();
        }
        let scripts = find_scripts(&d.join("v.mp4"));
        let names: Vec<_> = scripts.iter().map(|s| (s.axis, s.variant.as_deref())).collect();
        assert_eq!(names, vec![(Axis::L0, None), (Axis::L0, Some("max")), (Axis::L0, Some("plus")), (Axis::R1, Some("plus"))]);
        let selected = select_default(&scripts);
        assert_eq!(selected.iter().filter(|s| s.axis == Axis::L0).map(|s| s.variant.as_deref()).collect::<Vec<_>>(), vec![None]);
    }

    #[test]
    fn existing_hyphen_editions_own_their_plain_and_axis_scripts() {
        let d = tmp("hyphen-edition-owners");
        for name in ["v.mp4", "v-max.mp4", "v-plus.MK3D"] {
            fs::write(d.join(name), b"").unwrap();
        }
        for name in ["v.funscript", "v-max.funscript", "v-max.roll.funscript", "v-plus.funscript", "v-plus.twist.funscript"] {
            fs::write(d.join(name), ONE).unwrap();
        }
        let base = find_scripts(&d.join("v.mp4"));
        assert_eq!(base.iter().map(|s| (s.axis, s.variant.as_deref())).collect::<Vec<_>>(), vec![(Axis::L0, None)]);
        assert_eq!(base[0].source, d.join("v.funscript"));
        let max = find_scripts(&d.join("v-max.mp4"));
        assert_eq!(max.iter().map(|s| (s.axis, s.variant.as_deref())).collect::<Vec<_>>(), vec![(Axis::L0, None), (Axis::R1, None)]);
        let plus = find_scripts(&d.join("v-plus.MK3D"));
        assert_eq!(plus.iter().map(|s| (s.axis, s.variant.as_deref())).collect::<Vec<_>>(), vec![(Axis::L0, None), (Axis::R0, None)]);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn longest_existing_video_stem_wins_without_similar_or_nonvideo_names_suppressing_variants() {
        let d = tmp("hyphen-longest-owner");
        for name in ["v.mp4", "v-max.mp4", "v-max.roll.hevc", "v-maximal.mp4", "v-plus.txt"] {
            fs::write(d.join(name), b"").unwrap();
        }
        fs::create_dir(d.join("v-plus.mp4")).unwrap();
        for name in ["v-max.funscript", "v-max.roll.funscript", "v-plus.funscript"] {
            fs::write(d.join(name), ONE).unwrap();
        }
        let base = find_scripts(&d.join("v.mp4"));
        assert_eq!(base.iter().map(|s| (s.axis, s.variant.as_deref())).collect::<Vec<_>>(), vec![(Axis::L0, Some("plus"))]);
        let max = find_scripts(&d.join("v-max.mp4"));
        assert_eq!(max.iter().map(|s| (s.axis, s.variant.as_deref())).collect::<Vec<_>>(), vec![(Axis::L0, None)]);
        let roll = find_scripts(&d.join("v-max.roll.hevc"));
        assert_eq!(roll.iter().map(|s| (s.axis, s.variant.as_deref())).collect::<Vec<_>>(), vec![(Axis::L0, None)]);
        assert_eq!(roll[0].source, d.join("v-max.roll.funscript"));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn capped_directory_does_not_assume_a_hyphen_variant_has_no_edition_video() {
        let d = tmp("hyphen-directory-cap");
        fs::write(d.join("v-max.funscript"), ONE).unwrap();
        let mut budget = LoadBudget { directory_entries: 1, ..LoadBudget::default() };
        assert!(find_scripts_in(&d.join("v.mp4"), &mut budget).is_empty());
        assert_eq!(find_scripts(&d.join("v.mp4")).len(), 1);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn edition_precedence_does_not_change_ordinary_dot_axis_matching() {
        let d = tmp("ordinary-dot-matching");
        fs::write(d.join("v.roll.mp4"), b"").unwrap();
        fs::write(d.join("v.roll.funscript"), ONE).unwrap();
        let scripts = find_scripts(&d.join("v.mp4"));
        assert_eq!(scripts.iter().map(|s| (s.axis, s.variant.as_deref())).collect::<Vec<_>>(), vec![(Axis::R1, None)]);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn axes_bundle_and_channels() {
        let d = tmp("bundle");
        fs::write(
            d.join("a.funscript"),
            r#"{"version":"1.1","actions":[{"at":0,"pos":0},{"at":1,"pos":1}],"axes":[{"id":"R0","actions":[{"at":0,"pos":50}]},{"id":"zz","actions":[]}]}"#,
        )
        .unwrap();
        let s = find_scripts(&d.join("a.mkv"));
        assert_eq!(s.iter().map(|x| (x.axis, x.container)).collect::<Vec<_>>(), vec![(Axis::L0, Container::Axes), (Axis::R0, Container::Axes)]);

        fs::write(d.join("b.funscript"), r#"{"channels":{"stroke":{"actions":[{"at":0,"pos":10}]},"sway":{"actions":[{"at":0,"pos":10}]}}}"#).unwrap();
        let s = find_scripts(&d.join("b.mp4"));
        assert_eq!(s.iter().map(|x| x.axis).collect::<Vec<_>>(), vec![Axis::L0, Axis::L2]);
        assert!(s.iter().all(|x| x.container == Container::Channels));
    }

    #[test]
    fn official_v2_root_survives_other_channels_with_metadata_and_inversion() {
        let d = tmp("v2-root");
        fs::write(d.join("v.funscript"), r#"{
            "version":"2.0","inverted":true,
            "actions":[{"at":0,"pos":10},{"at":1000,"pos":90}],
            "channels":{"roll":{"actions":[{"at":0,"pos":20}]},"pitch":{"actions":[{"at":0,"pos":30}]}},
            "metadata":{"title":"Clip","creator":"Creator","duration":5,"license":"CC-BY",
                "chapters":[{"name":"Intro","startTime":"0","endTime":"1"}],
                "bookmarks":[{"name":"Start","time":"0.5"}]}
        }"#).unwrap();
        let scripts = find_scripts(&d.join("v.mp4"));
        assert_eq!(scripts.iter().map(|s| s.axis).collect::<Vec<_>>(), vec![Axis::L0, Axis::R1, Axis::R2]);
        let root = &scripts[0];
        assert_eq!(root.script.actions[0].pos, 0.9);
        assert!(root.multi_axis.is_none());
        assert_eq!(root.script_for(false), root.script_for(true));
        assert_eq!(root.script.metadata["creator"], "Creator");
        assert_eq!(root.script.metadata["license"], "CC-BY");
        assert!(!root.script.metadata.contains_key("duration"));
        assert_eq!(root.script.chapters[0].end_ms, 1000.0);
        assert_eq!(root.script.bookmarks[0].at_ms, 500.0);
        let saved: serde_json::Value = serde_json::from_str(&root.script.to_json_with(Some(10.0))).unwrap();
        assert_eq!(saved["metadata"]["title"], "Clip");
        assert_eq!(saved["metadata"]["chapters"][0]["name"], "Intro");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn v2_root_and_channel_stroke_keep_distinct_output_representations() {
        let d = tmp("v2-dual");
        fs::write(d.join("v.alternative.funscript"), r#"{
            "version":"2.0","inverted":true,"actions":[{"at":0,"pos":10}],
            "channels":{"stroke":{"inverted":true,"actions":[{"at":0,"pos":60}]},"roll":{"actions":[{"at":0,"pos":20}]}},
            "metadata":{"creator":"Creator","chapters":[{"name":"A","startTime":"0","endTime":"1"}],"bookmarks":[{"name":"B","time":"0.5"}]}
        }"#).unwrap();
        let scripts = find_scripts(&d.join("v.mp4"));
        assert_eq!(scripts.len(), 2);
        let stroke = &scripts[0];
        assert_eq!(stroke.axis, Axis::L0);
        assert_eq!(stroke.variant.as_deref(), Some("alternative"));
        assert_eq!(stroke.script_for(false).actions[0].pos, 0.9);
        assert_eq!(stroke.script_for(true).actions[0].pos, 0.4);
        assert_eq!(stroke.script_for(true).metadata, stroke.script.metadata);
        assert_eq!(stroke.script_for(true).chapters, stroke.script.chapters);
        assert_eq!(stroke.script_for(true).bookmarks, stroke.script.bookmarks);
        assert_eq!(select_default(&scripts).len(), 2);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn channel_only_and_empty_root_promote_stroke_with_file_metadata() {
        let d = tmp("v2-no-root");
        for (name, actions) in [("absent", ""), ("empty", "\"actions\":[],")] {
            fs::write(d.join(format!("{name}.funscript")), format!(r#"{{{actions}"inverted":true,"metadata":{{"creator":"Creator"}},"channels":{{"stroke":{{"actions":[{{"at":0,"pos":25}}]}}}}}}"#)).unwrap();
            let scripts = find_scripts(&d.join(format!("{name}.mp4")));
            assert_eq!(scripts.len(), 1);
            assert_eq!(scripts[0].script.actions[0].pos, 0.25, "channel inversion is independent of root inversion");
            assert_eq!(scripts[0].script.metadata["creator"], "Creator");
            assert!(scripts[0].multi_axis.is_none());
        }
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn channel_only_nonstroke_keeps_file_metadata_and_markers() {
        let d = tmp("v2-roll-only");
        fs::write(d.join("v.funscript"), r#"{
            "channels":{"roll":{"actions":[{"at":0,"pos":25}]}},
            "metadata":{"creator":"Creator","chapters":[{"name":"A","startTime":"0","endTime":"1"}],"bookmarks":[{"name":"B","time":"0.5"}]}
        }"#).unwrap();
        let scripts = find_scripts(&d.join("v.mp4"));
        assert_eq!(scripts.len(), 1);
        assert_eq!(scripts[0].axis, Axis::R1);
        assert_eq!(scripts[0].script.metadata["creator"], "Creator");
        assert_eq!(scripts[0].script.chapters[0].end_ms, 1000.0);
        assert_eq!(scripts[0].script.bookmarks[0].at_ms, 500.0);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn empty_channel_does_not_hide_root_and_axes_coexist_with_channels() {
        let d = tmp("mixed-containers");
        fs::write(d.join("v.roll.FuNsCrIpT"), r#"{"actions":[{"at":0,"pos":15}],"axes":[{"id":"L1","actions":[{"at":0,"pos":25}]}],"channels":{"roll":{"actions":[]},"pitch":{"actions":[{"at":0,"pos":35}]}}}"#).unwrap();
        let scripts = find_scripts(&d.join("v.mp4"));
        assert_eq!(scripts.iter().map(|s| s.axis).collect::<Vec<_>>(), vec![Axis::L1, Axis::R1, Axis::R2]);
        assert_eq!(scripts[1].script.actions[0].pos, 0.15);
        assert!(scripts[1].multi_axis.is_none());
        fs::remove_dir_all(d).unwrap();
    }

    fn write_zip(path: &Path, entries: &[(&str, &str)]) {
        let f = fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, text) in entries {
            z.start_file(*name, options).unwrap();
            z.write_all(text.as_bytes()).unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    fn zip_bare_axes_nested_entries_other_stems_and_case_are_recognized() {
        let d = tmp("zip-names");
        write_zip(&d.join("v.ZiP"), &[
            ("stroke.funscript", ONE),
            ("nested/roll.FuNsCrIpT", ONE),
            ("nested/different.alternative.pitch.FUNSCRIPT", ONE),
            ("another.MAX.funscript", ONE),
            ("nested/v.alternative.roll.funscript", ONE),
            ("../escape.twist.funscript", ONE),
        ]);
        let scripts = find_scripts(&d.join("v.mp4"));
        assert_eq!(scripts.iter().map(|s| (s.axis, s.variant.as_deref())).collect::<Vec<_>>(), vec![
            (Axis::L0, None), (Axis::L0, Some("MAX")), (Axis::R1, None),
            (Axis::R1, Some("alternative")), (Axis::R2, Some("alternative")),
        ]);
        assert!(scripts.iter().all(|s| s.container == Container::Zip));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn zip_bundles_keep_dual_stroke() {
        let d = tmp("zip-dual");
        write_zip(&d.join("v.zip"), &[("nested/different.funscript", r#"{"actions":[{"at":0,"pos":10}],"channels":{"stroke":{"actions":[{"at":0,"pos":80}]}}}"#)]);
        let scripts = find_scripts(&d.join("v.mp4"));
        assert_eq!(scripts.len(), 1);
        assert_eq!(scripts[0].script_for(false).actions[0].pos, 0.1);
        assert_eq!(scripts[0].script_for(true).actions[0].pos, 0.8);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn bounded_script_read_checks_actual_bytes_at_the_boundary() {
        let mut budget = LoadBudget { bytes: ONE.len(), ..LoadBudget::default() };
        assert_eq!(read_script(&mut Cursor::new(ONE.as_bytes()), &mut budget).as_deref(), Some(ONE));
        assert_eq!(budget.bytes, 0);
        let mut budget = LoadBudget { bytes: ONE.len() - 1, ..LoadBudget::default() };
        assert!(read_script(&mut Cursor::new(ONE.as_bytes()), &mut budget).is_none());
        assert_eq!(budget.bytes, 0);
    }

    #[test]
    fn oversized_sibling_and_compressed_archive_are_skipped() {
        let d = tmp("size-limits");
        fs::File::create(d.join("v.funscript")).unwrap().set_len(MAX_SCRIPT_BYTES as u64 + 1).unwrap();
        fs::File::create(d.join("v.zip")).unwrap().set_len(MAX_ZIP_BYTES as u64 + 1).unwrap();
        assert!(find_scripts(&d.join("v.mp4")).is_empty());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn zip_entry_expansion_and_aggregate_action_limits_are_enforced() {
        let d = tmp("zip-limits");
        let zip_path = d.join("v.zip");
        write_zip(&zip_path, &[("stroke.funscript", ONE), ("roll.funscript", ONE)]);
        let mut budget = LoadBudget { bytes: 2 * ONE.len(), actions: 4, ..LoadBudget::default() };
        assert_eq!(read_zip(&zip_path, "v", &mut budget).len(), 2);
        let mut budget = LoadBudget { bytes: 2 * ONE.len() - 1, ..LoadBudget::default() };
        assert!(read_zip(&zip_path, "v", &mut budget).is_empty());
        let mut budget = LoadBudget { files: 1, ..LoadBudget::default() };
        assert!(read_zip(&zip_path, "v", &mut budget).is_empty());
        let mut budget = LoadBudget { actions: 3, ..LoadBudget::default() };
        assert!(read_zip(&zip_path, "v", &mut budget).is_empty());

        let f = fs::File::create(&zip_path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        for index in 0..=MAX_ZIP_ENTRIES {
            z.start_file(format!("{index}.txt"), zip::write::SimpleFileOptions::default()).unwrap();
        }
        z.finish().unwrap();
        assert!(read_zip(&zip_path, "v", &mut LoadBudget::default()).is_empty());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn stored_zip_payload_signatures_are_not_archive_headers() {
        let d = tmp("zip-signatures");
        let zip_path = d.join("v.zip");
        let f = fs::File::create(&zip_path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        z.start_file("noise.bin", options).unwrap();
        z.write_all(b"PK\x06\x06PK\x06\x07PK\x05\x06\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff").unwrap();
        z.start_file("stroke.funscript", options).unwrap();
        z.write_all(ONE.as_bytes()).unwrap();
        z.set_comment("ZIP comments may contain PK\u{0006}\u{0006} signatures");
        z.finish().unwrap();
        assert_eq!(read_zip(&zip_path, "v", &mut LoadBudget::default()).len(), 1);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn zip_beside_media_fills_missing_axes() {
        let d = tmp("zip");
        fs::write(d.join("v.funscript"), ONE).unwrap();
        let f = fs::File::create(d.join("v.zip")).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let o = zip::write::SimpleFileOptions::default();
        z.start_file("v.funscript", o).unwrap();
        z.write_all(br#"{"actions":[{"at":0,"pos":99}]}"#).unwrap();
        z.start_file("whatever.pitch.funscript", o).unwrap();
        z.write_all(ONE.as_bytes()).unwrap();
        z.finish().unwrap();
        let s = find_scripts(&d.join("v.mp4"));
        assert_eq!(s.iter().map(|x| (x.axis, x.container)).collect::<Vec<_>>(), vec![(Axis::L0, Container::Sibling), (Axis::R2, Container::Zip)]);
        assert_eq!(s[0].script.actions[1].pos, 1.0, "sibling wins over the zip");
    }
}
