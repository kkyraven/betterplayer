use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::axis::Axis;
use crate::funscript::{Raw, Script};

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
}




pub fn find_scripts(media: &Path) -> Vec<LoadedScript> {
    let Some(stem) = media.file_stem().and_then(|s| s.to_str()) else { return Vec::new() };
    let dir = media.parent().unwrap_or(Path::new("."));
    let mut found: BTreeMap<(Axis, u8, String), LoadedScript> = BTreeMap::new();
    let mut add = |s: LoadedScript| {
        if !s.script.is_empty() {
            let key = (s.axis, s.variant.is_some() as u8, s.variant.clone().unwrap_or_default());
            found.entry(key).or_insert(s);
        }
    };

    let mut siblings: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| suffix_for(p, stem).is_some()).collect())
        .unwrap_or_default();
    siblings.sort();
    for path in siblings {
        let Ok(text) = fs::read_to_string(&path) else { continue };
        for s in parse_any(&text, &path, suffix_for(&path, stem).unwrap_or_default()) {
            add(s);
        }
    }

    let zip_path = dir.join(format!("{stem}.zip"));
    if zip_path.is_file() {
        for s in read_zip(&zip_path, stem) {
            add(s);
        }
    }
    found.into_values().collect()
}





fn suffix_for(path: &Path, stem: &str) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let rest = name.strip_prefix(stem)?;
    let rest = rest.strip_suffix(".funscript").or_else(|| rest.strip_suffix(".FUNSCRIPT"))?;
    if rest.is_empty() {
        return Some(String::new());
    }
    if let Some(inner) = rest.strip_prefix(" (").and_then(|r| r.strip_suffix(')')) {
        return (!inner.is_empty()).then(|| inner.to_string());
    }
    rest.strip_prefix(['.', '_']).map(str::to_string)
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



fn parse_any(text: &str, source: &Path, suffix: String) -> Vec<LoadedScript> {
    let Ok(raw) = Raw::parse(text) else { return Vec::new() };
    let mut out = Vec::new();
    let (file_axis, variant) = if suffix.is_empty() { (Axis::L0, None) } else { classify_suffix(&suffix) };
    let Raw { actions, inverted, metadata, axes, channels } = raw;
    if let Some(axes) = axes {


        let root = Script::from_raw(actions, inverted, metadata);
        out.push(LoadedScript { axis: file_axis, variant: variant.clone(), source: source.into(), container: Container::Axes, script: root });
        for a in axes {
            if let Some(axis) = Axis::from_id(&a.id).or_else(|| Axis::from_suffix(&a.id)) {
                let script = Script::from_raw(a.actions, a.inverted, None);
                out.push(LoadedScript { axis, variant: variant.clone(), source: source.into(), container: Container::Axes, script });
            }
        }
    } else if let Some(channels) = channels {
        for (name, ch) in channels {
            if let Some(axis) = Axis::from_suffix(&name).or_else(|| Axis::from_id(&name)) {
                let script = Script::from_raw(ch.actions, ch.inverted, None);
                out.push(LoadedScript { axis, variant: variant.clone(), source: source.into(), container: Container::Channels, script });
            }
        }
    } else {
        let script = Script::from_raw(actions, inverted, metadata);
        out.push(LoadedScript { axis: file_axis, variant, source: source.into(), container: Container::Sibling, script });
    }
    out
}

fn read_zip(zip_path: &Path, stem: &str) -> Vec<LoadedScript> {
    let mut out = Vec::new();
    let Ok(file) = fs::File::open(zip_path) else { return out };
    let Ok(mut archive) = zip::ZipArchive::new(file) else { return out };
    let mut names: Vec<String> = archive.file_names().map(String::from).collect();
    names.sort();
    for name in names {
        let inner = Path::new(&name);

        let suffix = suffix_for(inner, stem).or_else(|| {
            let n = inner.file_name()?.to_str()?.strip_suffix(".funscript")?;
            Some(n.split_once('.').map(|(_, rest)| rest).unwrap_or("").to_string())
        });
        let Some(suffix) = suffix else { continue };
        let Ok(mut entry) = archive.by_name(&name) else { continue };
        let mut text = String::new();
        if entry.read_to_string(&mut text).is_err() {
            continue;
        }
        for mut s in parse_any(&text, zip_path, suffix) {
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
