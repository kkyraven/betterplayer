use crate::mpv::{Event, Mpv};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioDevice {
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AudioEvent {
    None,
    Loaded { path: Option<String>, duration: f64 },
    Restarted,
    Ended { error: Option<String> },
    DevicesChanged,
    FilterFailed,
    Shutdown,
}

const SWAP_CHANNELS: &str = "lavfi=[aformat=channel_layouts=stereo,pan=stereo|c0=c1|c1=c0]";

pub struct AudioOut {
    mpv: Mpv,
}

impl AudioOut {
    pub fn new() -> Result<AudioOut, String> {
        let mpv = Mpv::create()?;
        for (key, value) in [
            ("vo", "null"),
            ("vid", "no"),
            ("sid", "no"),
            ("audio-display", "no"),
            ("idle", "yes"),
            ("keep-open", "yes"),
            ("pause", "yes"),
            ("ytdl", "no"),
            ("hr-seek", "yes"),
            ("gapless-audio", "no"),
            ("audio-channels", "stereo"),
            ("volume-max", "100"),
            ("volume", "0"),
        ] {
            mpv.set_option(key, value)?;
        }
        mpv.request_log("warn")?;
        mpv.initialize()?;
        mpv.observe("audio-device-list", 0)?;
        Ok(AudioOut { mpv })
    }

    pub fn devices(&self) -> Vec<AudioDevice> {
        self.mpv.get_string("audio-device-list").map(|json| parse_devices(&json)).unwrap_or_default()
    }

    pub fn set_device(&self, name: &str) -> Result<(), String> {
        self.mpv.set_property("audio-device", name)
    }

    pub fn load(&self, path: &str) -> Result<(), String> {
        self.mpv.set_property("pause", "yes")?;
        self.mpv.command(&["loadfile", path])
    }

    pub fn stop(&self) -> Result<(), String> {
        self.mpv.set_property("pause", "yes")?;
        self.mpv.command(&["stop"])
    }

    pub fn set_paused(&self, paused: bool) -> Result<(), String> {
        self.mpv.set_property("pause", if paused { "yes" } else { "no" })
    }

    pub fn seek(&self, seconds: f64) -> Result<(), String> {
        self.mpv.command(&["seek", &format!("{seconds:.4}"), "absolute+exact"])
    }

    pub fn set_speed(&self, speed: f64) -> Result<(), String> {
        self.mpv.set_property("speed", &format!("{:.5}", speed.clamp(0.05, 8.0)))
    }

    pub fn set_gain(&self, gain: f64) -> Result<(), String> {
        self.mpv.set_property("volume", &format!("{:.4}", mpv_volume(gain)))
    }

    pub fn set_swapped(&self, swapped: bool) -> Result<(), String> {
        self.mpv.set_property("af", if swapped { SWAP_CHANNELS } else { "" })
    }

    pub fn position(&self) -> Option<f64> {
        self.mpv.get_double("audio-pts").or_else(|| self.mpv.get_double("time-pos"))
    }

    pub fn duration(&self) -> f64 {
        self.mpv.get_double("duration").unwrap_or(0.0)
    }

    pub fn next_event(&self, timeout: f64) -> AudioEvent {
        let mut timeout = timeout;
        loop {
            match self.mpv.wait_event(timeout) {
                Event::FileLoaded => return AudioEvent::Loaded { path: self.mpv.get_string("path"), duration: self.duration() },
                Event::PlaybackRestart => return AudioEvent::Restarted,
                Event::EndFile { error } => return AudioEvent::Ended { error },
                Event::Property { name, .. } if name == "audio-device-list" => return AudioEvent::DevicesChanged,
                Event::Log(line) if line.contains("Disabling filter") => return AudioEvent::FilterFailed,
                Event::Shutdown => return AudioEvent::Shutdown,
                Event::None => return AudioEvent::None,
                _ => timeout = 0.0,
            }
        }
    }
}

pub(crate) fn mpv_volume(gain: f64) -> f64 {
    gain.clamp(0.0, 1.0).cbrt() * 100.0
}

fn parse_devices(json: &str) -> Vec<AudioDevice> {
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let all: Vec<AudioDevice> = items
        .iter()
        .filter_map(|d| {
            let name = d.get("name")?.as_str()?.to_string();
            let description = d.get("description").and_then(|v| v.as_str()).unwrap_or(&name).to_string();
            (name != "auto").then_some(AudioDevice { name, description })
        })
        .collect();
    let driver = |d: &AudioDevice| d.name.split('/').next().unwrap_or_default().to_string();
    let Some(first) = all.first().map(driver) else { return all };
    all.into_iter().filter(|d| driver(d) == first).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gain_is_linear_amplitude() {
        assert_eq!(mpv_volume(0.0), 0.0);
        assert!((mpv_volume(1.0) - 100.0).abs() < 1e-9);
        assert!(((mpv_volume(0.5) / 100.0).powi(3) - 0.5).abs() < 1e-9);
        assert!((mpv_volume(2.0) - 100.0).abs() < 1e-9);
    }

    #[test]
    fn devices_keep_the_preferred_driver_without_auto() {
        let json = r#"[{"name":"auto","description":"Autoselect device"},{"name":"wasapi/{a}","description":"Speakers"},{"name":"wasapi/{b}","description":"USB Audio"},{"name":"openal/x","description":"Speakers"}]"#;
        let devices = parse_devices(json);
        assert_eq!(devices.iter().map(|d| d.description.as_str()).collect::<Vec<_>>(), ["Speakers", "USB Audio"]);
        assert_eq!(devices[1].name, "wasapi/{b}");
        assert!(parse_devices("not json").is_empty());
    }
}
