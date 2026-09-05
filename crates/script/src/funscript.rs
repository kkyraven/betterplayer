use std::collections::BTreeMap;

use serde::Deserialize;


#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Action {
    pub at: f64,
    pub pos: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Chapter {
    pub name: String,
    pub start_ms: f64,
    pub end_ms: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Bookmark {
    pub name: String,
    pub at_ms: f64,
}



#[derive(Clone, Debug, Default, PartialEq)]
pub struct Script {
    pub actions: Vec<Action>,
    pub chapters: Vec<Chapter>,
    pub bookmarks: Vec<Bookmark>,
}



#[derive(Deserialize)]
pub(crate) struct Raw {
    #[serde(default)]
    pub actions: Vec<RawAction>,
    #[serde(default)]
    pub inverted: bool,
    #[serde(default)]
    pub metadata: Option<RawMeta>,

    #[serde(default)]
    pub axes: Option<Vec<RawAxis>>,

    #[serde(default)]
    pub channels: Option<BTreeMap<String, RawChannel>>,
}

#[derive(Deserialize)]
pub(crate) struct RawAction {
    pub at: f64,
    pub pos: f64,
}

#[derive(Deserialize)]
pub(crate) struct RawAxis {
    pub id: String,
    #[serde(default)]
    pub actions: Vec<RawAction>,
    #[serde(default)]
    pub inverted: bool,
}

#[derive(Deserialize)]
pub(crate) struct RawChannel {
    #[serde(default)]
    pub actions: Vec<RawAction>,
    #[serde(default)]
    pub inverted: bool,
}

impl Raw {
    pub(crate) fn parse(json: &str) -> Result<Raw, String> {
        serde_json::from_str(json).map_err(|e| e.to_string())
    }
}

#[derive(Deserialize, Default)]
pub(crate) struct RawMeta {
    #[serde(default)]
    chapters: Vec<RawChapter>,
    #[serde(default)]
    bookmarks: Vec<RawBookmark>,
}

#[derive(Deserialize)]
struct RawChapter {
    #[serde(default)]
    name: String,
    #[serde(rename = "startTime", default)]
    start: String,
    #[serde(rename = "endTime", default)]
    end: String,
}

#[derive(Deserialize)]
struct RawBookmark {
    #[serde(default)]
    name: String,
    #[serde(default)]
    time: String,
}

impl Script {
    pub fn parse(json: &str) -> Result<Script, String> {
        let raw = Raw::parse(json)?;
        Ok(Self::from_raw(raw.actions, raw.inverted, raw.metadata))
    }



    pub fn to_json(&self) -> String {
        let actions: Vec<serde_json::Value> = self.actions.iter().map(|a| serde_json::json!({ "at": a.at.round() as i64, "pos": (a.pos.clamp(0.0, 1.0) * 100.0).round() as i64 })).collect();
        let mut root = serde_json::json!({ "version": "1.0", "inverted": false, "range": 100, "actions": actions });
        if !self.chapters.is_empty() || !self.bookmarks.is_empty() {
            let clock = |ms: f64| {
                let total = (ms.max(0.0) / 1000.0).floor() as u64;
                format!("{:02}:{:02}:{:02}.{:03}", total / 3600, total / 60 % 60, total % 60, (ms.max(0.0) % 1000.0).round() as u64 % 1000)
            };
            root["metadata"] = serde_json::json!({
                "chapters": self.chapters.iter().map(|c| serde_json::json!({ "name": c.name, "startTime": clock(c.start_ms), "endTime": clock(c.end_ms) })).collect::<Vec<_>>(),
                "bookmarks": self.bookmarks.iter().map(|b| serde_json::json!({ "name": b.name, "time": clock(b.at_ms) })).collect::<Vec<_>>(),
            });
        }
        root.to_string()
    }


    pub(crate) fn from_raw(actions: Vec<RawAction>, inverted: bool, meta: Option<RawMeta>) -> Script {
        let mut actions: Vec<Action> = actions
            .into_iter()
            .filter(|a| a.at.is_finite() && a.pos.is_finite())
            .map(|a| {
                let mut pos = (a.pos / 100.0).clamp(0.0, 1.0);
                if inverted {
                    pos = 1.0 - pos;
                }
                Action { at: a.at.max(0.0), pos }
            })
            .collect();
        actions.sort_by(|a, b| a.at.total_cmp(&b.at));

        actions.dedup_by(|later, earlier| {
            if later.at == earlier.at {
                earlier.pos = later.pos;
                true
            } else {
                false
            }
        });
        let meta = meta.unwrap_or_default();
        Script {
            actions,
            chapters: meta
                .chapters
                .into_iter()
                .filter_map(|c| Some(Chapter { name: c.name, start_ms: parse_time(&c.start)?, end_ms: parse_time(&c.end)? }))
                .collect(),
            bookmarks: meta
                .bookmarks
                .into_iter()
                .filter_map(|b| Some(Bookmark { name: b.name, at_ms: parse_time(&b.time)? }))
                .collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.actions.is_empty()
    }


    pub fn duration_ms(&self) -> f64 {
        self.actions.last().map_or(0.0, |a| a.at)
    }


    pub fn index_at(&self, t_ms: f64) -> Option<usize> {
        self.actions.partition_point(|a| a.at <= t_ms).checked_sub(1)
    }


    pub fn extent(&self) -> Option<(f64, f64)> {
        self.actions.iter().map(|a| a.pos).fold(None, |acc, p| match acc {
            None => Some((p, p)),
            Some((lo, hi)) => Some((lo.min(p), hi.max(p))),
        })
    }
}


fn parse_time(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let mut total = 0.0;
    for part in s.split(':') {
        total = total * 60.0 + part.trim().parse::<f64>().ok()?;
    }
    Some(total * 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tolerates_messy_files() {
        let s = Script::parse(
            r#"{"version":"1.0","range":90,"actions":[
                {"at":1000.5,"pos":100},{"at":0,"pos":-5},{"at":1000.5,"pos":40},{"at":500,"pos":250.0}
            ],"metadata":{"chapters":[{"name":"a","startTime":"00:00:01.500","endTime":"00:00:02"}],
              "bookmarks":[{"name":"b","time":"01:02.250"},{"name":"bad","time":""}]}}"#,
        )
        .unwrap();
        assert_eq!(s.actions.len(), 3);
        assert_eq!(s.actions[0], Action { at: 0.0, pos: 0.0 });
        assert_eq!(s.actions[1], Action { at: 500.0, pos: 1.0 });
        assert_eq!(s.actions[2], Action { at: 1000.5, pos: 0.4 });
        assert_eq!(s.chapters, vec![Chapter { name: "a".into(), start_ms: 1500.0, end_ms: 2000.0 }]);
        assert_eq!(s.bookmarks, vec![Bookmark { name: "b".into(), at_ms: 62250.0 }]);
    }

    #[test]
    fn inverted_flips_and_missing_actions_is_empty() {
        let s = Script::parse(r#"{"inverted":true,"actions":[{"at":0,"pos":10}]}"#).unwrap();
        assert_eq!(s.actions[0].pos, 0.9);
        assert!(Script::parse(r#"{"metadata":{}}"#).unwrap().is_empty());
        assert!(Script::parse("nope").is_err());
    }
}
