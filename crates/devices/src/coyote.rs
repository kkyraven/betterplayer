use std::io;

use crate::ble::{self, BleConn};


pub const MAX_STRENGTH: u8 = 200;

const SLOT_MS: f64 = 25.0;
const SLOTS: usize = 4;

const REST_PERIOD_MS: f64 = 100.0;
const FAST_PERIOD_MS: f64 = 20.0;

const FAST_UNITS_PER_SEC: f64 = 2.0;

const SENSITIVITY: f64 = 1.0;

const STRENGTH_STEP: u8 = 4;

const ACK_LIMIT: u8 = 10;

const BALANCE: u8 = 128;


#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum StrengthMode {
    #[default]
    NoChange = 0,
    Up = 1,
    Down = 2,
    Set = 3,
}



#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Channel {
    pub freq: [u8; SLOTS],
    pub intensity: [u8; SLOTS],
}

impl Channel {


    fn valid(&self) -> bool {
        self.freq.iter().all(|f| (10..=240).contains(f)) && self.intensity.iter().all(|i| *i <= 100)
    }
}



pub fn encode_frequency(period_ms: u32) -> u8 {
    match period_ms {
        10..=100 => period_ms as u8,
        101..=600 => ((period_ms - 100) / 5 + 100) as u8,
        601..=1000 => ((period_ms - 600) / 10 + 200) as u8,
        _ => 10,
    }
}


pub fn b0(
    seq: u8,
    mode_a: StrengthMode,
    mode_b: StrengthMode,
    strength_a: u8,
    strength_b: u8,
    a: Channel,
    b: Channel,
) -> [u8; 20] {
    let mut out = [0u8; 20];
    out[0] = 0xB0;
    out[1] = (seq & 0x0F) << 4 | (mode_a as u8) << 2 | mode_b as u8;
    out[2] = strength_a.min(MAX_STRENGTH);
    out[3] = strength_b.min(MAX_STRENGTH);
    for (i, channel) in [a, b].iter().enumerate() {
        if !channel.valid() {
            continue;
        }
        let at = 4 + i * 8;
        out[at..at + SLOTS].copy_from_slice(&channel.freq);
        out[at + SLOTS..at + 2 * SLOTS].copy_from_slice(&channel.intensity);
    }
    out
}



pub fn bf(
    limit_a: u8,
    limit_b: u8,
    freq_balance_a: u8,
    freq_balance_b: u8,
    intensity_balance_a: u8,
    intensity_balance_b: u8,
) -> [u8; 7] {
    [
        0xBF,
        limit_a.min(MAX_STRENGTH),
        limit_b.min(MAX_STRENGTH),
        freq_balance_a,
        freq_balance_b,
        intensity_balance_a,
        intensity_balance_b,
    ]
}


#[derive(Clone, Copy, Debug, PartialEq)]
pub struct B1 {
    pub seq: u8,
    pub strength_a: u8,
    pub strength_b: u8,
}

pub fn parse_b1(bytes: &[u8]) -> Option<B1> {
    match bytes {
        [0xB1, seq, a, b, ..] => Some(B1 {
            seq: *seq,
            strength_a: *a,
            strength_b: *b,
        }),
        _ => None,
    }
}


pub fn stop() -> [u8; 20] {
    let rest = Channel {
        freq: [encode_frequency(REST_PERIOD_MS as u32); SLOTS],
        intensity: [0; SLOTS],
    };
    b0(0, StrengthMode::Set, StrengthMode::Set, 0, 0, rest, rest)
}


#[derive(Clone, Copy, Default)]
struct Slot {
    pos: f64,

    speed: f64,

    intensity: f64,
}




pub struct CoyoteMapper {

    target: (u8, u8),

    device: (u8, u8),

    pending: Option<(u8, u8)>,
    seq: u8,
    last_pos: Option<f64>,
    slot_ms: f64,
    sums: Slot,
    slots: Vec<Slot>,
}

impl CoyoteMapper {
    pub fn new(strength_a: u8, strength_b: u8) -> CoyoteMapper {
        CoyoteMapper {
            target: (strength_a.min(MAX_STRENGTH), strength_b.min(MAX_STRENGTH)),
            device: (0, 0),
            pending: None,
            seq: 0,
            last_pos: None,
            slot_ms: 0.0,
            sums: Slot::default(),
            slots: Vec::with_capacity(SLOTS),
        }
    }

    pub fn set_strength(&mut self, a: u8, b: u8) {
        self.target = (a.min(MAX_STRENGTH), b.min(MAX_STRENGTH));
    }


    pub fn strength(&self) -> (u8, u8) {
        self.target
    }



    pub fn ack(&mut self, reply: B1) {
        let strengths = (reply.strength_a, reply.strength_b);
        if reply.seq == 0 {
            self.target = strengths;
        } else if self.pending.is_some_and(|(seq, _)| seq == reply.seq) {
            self.pending = None;
        }
        self.device = strengths;
    }




    pub fn tick(
        &mut self,
        pos: f64,
        volume: f64,
        driven: bool,
        playing: bool,
        interval_ms: u32,
    ) -> Option<[u8; 20]> {
        let dt = (interval_ms.max(1) as f64).min(100.0);
        let active = driven && playing;
        let pos = pos.clamp(0.0, 1.0);
        let speed = match self.last_pos {
            Some(last) if active => {
                ((pos - last).abs() * 1000.0 / dt / FAST_UNITS_PER_SEC).clamp(0.0, 1.0)
            }
            _ => 0.0,
        };
        self.last_pos = active.then_some(pos);
        let intensity = if active {
            (speed * SENSITIVITY * volume.clamp(0.0, 1.0)).clamp(0.0, 1.0)
        } else {
            0.0
        };


        let mut left = dt;
        while left > 0.0 {
            let take = left.min(SLOT_MS - self.slot_ms);
            self.sums.pos += pos * take;
            self.sums.speed += speed * take;
            self.sums.intensity += intensity * take;
            self.slot_ms += take;
            left -= take;
            if self.slot_ms >= SLOT_MS {
                self.slots.push(Slot {
                    pos: self.sums.pos / self.slot_ms,
                    speed: self.sums.speed / self.slot_ms,
                    intensity: self.sums.intensity / self.slot_ms,
                });
                self.sums = Slot::default();
                self.slot_ms = 0.0;
            }
        }
        if self.slots.len() < SLOTS {
            return None;
        }

        let mut a = Channel::default();
        let mut b = Channel::default();
        for (i, slot) in self.slots.drain(..).take(SLOTS).enumerate() {
            let period = REST_PERIOD_MS - slot.speed * (REST_PERIOD_MS - FAST_PERIOD_MS);
            let freq = encode_frequency(period.round() as u32);
            let level = slot.intensity * 100.0;
            a.freq[i] = freq;
            b.freq[i] = freq;
            a.intensity[i] = (level * slot.pos).round() as u8;
            b.intensity[i] = (level * (1.0 - slot.pos)).round() as u8;
        }
        let (mode_a, mode_b, strength_a, strength_b, seq) = self.strength_step();
        Some(b0(seq, mode_a, mode_b, strength_a, strength_b, a, b))
    }



    fn strength_step(&mut self) -> (StrengthMode, StrengthMode, u8, u8, u8) {
        let none = (StrengthMode::NoChange, StrengthMode::NoChange, 0, 0, 0);
        if let Some((seq, waited)) = self.pending {

            self.pending = (waited + 1 < ACK_LIMIT).then_some((seq, waited + 1));
            return none;
        }
        let step = |from: u8, to: u8| {
            if to > from {
                from.saturating_add(STRENGTH_STEP).min(to)
            } else {
                to
            }
        };
        let next = (
            step(self.device.0, self.target.0),
            step(self.device.1, self.target.1),
        );
        if next == self.device {
            return none;
        }
        self.seq = self.seq % 15 + 1;
        self.pending = Some((self.seq, 0));
        self.device = next;
        (
            StrengthMode::Set,
            StrengthMode::Set,
            next.0,
            next.1,
            self.seq,
        )
    }
}



pub struct CoyoteLink {
    conn: BleConn,
    mapper: CoyoteMapper,
    battery: Option<u8>,
}

impl CoyoteLink {



    pub fn open(target: &str, strength_a: u8, strength_b: u8) -> io::Result<CoyoteLink> {
        let conn = BleConn::open(
            target,
            ble::COYOTE_SERVICE,
            ble::COYOTE_WRITE,
            ble::COYOTE_NOTIFY,
        )?;
        let (a, b) = (strength_a.min(MAX_STRENGTH), strength_b.min(MAX_STRENGTH));
        conn.write(&bf(a, b, BALANCE, BALANCE, BALANCE, BALANCE))?;
        conn.write(&stop())?;
        conn.watch(ble::COYOTE_BATTERY);
        Ok(CoyoteLink {
            conn,
            mapper: CoyoteMapper::new(a, b),
            battery: None,
        })
    }


    pub fn poll(&mut self) -> io::Result<bool> {
        self.conn.check()?;
        let mut changed = false;
        for (uuid, payload) in self.conn.take_notifications() {
            if uuid == ble::COYOTE_BATTERY {
                let battery = payload.first().copied();
                changed |= battery != self.battery;
                self.battery = battery;
            } else if let Some(reply) = parse_b1(&payload) {
                self.mapper.ack(reply);
            }
        }
        Ok(changed)
    }


    pub fn send(
        &mut self,
        pos: f64,
        volume: f64,
        driven: bool,
        playing: bool,
        interval_ms: u32,
    ) -> io::Result<bool> {
        match self.mapper.tick(pos, volume, driven, playing, interval_ms) {
            Some(command) => {
                self.conn.write(&command)?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    pub fn set_strength(&mut self, a: u8, b: u8) {
        self.mapper.set_strength(a, b);
    }


    pub fn device(&self) -> String {
        match self.battery {
            Some(percent) => format!("Coyote v3, battery {percent}%"),
            None => "Coyote v3".to_string(),
        }
    }
}

impl Drop for CoyoteLink {
    fn drop(&mut self) {
        let _ = self.conn.write(&stop());
    }
}

#[cfg(test)]
mod tests {
    use super::*;


    fn channel(freq: u8, intensity: [u8; 4]) -> Channel {
        Channel {
            freq: [freq; 4],
            intensity,
        }
    }


    fn run(
        mapper: &mut CoyoteMapper,
        ticks: usize,
        mut pos: impl FnMut(usize) -> f64,
        driven: bool,
    ) -> Vec<[u8; 20]> {
        (0..ticks)
            .filter_map(|i| mapper.tick(pos(i), 1.0, driven, driven, 10))
            .collect()
    }

    #[test]
    fn frequency_encodes_as_a_period() {
        assert_eq!(encode_frequency(100), 100);
        assert_eq!(encode_frequency(20), 20);
        assert_eq!(encode_frequency(1000), 240);
        assert_eq!(encode_frequency(10), 10);
        assert_eq!(encode_frequency(101), 100);
        assert_eq!(encode_frequency(600), 200);
        assert_eq!(encode_frequency(601), 200);
        assert_eq!(encode_frequency(9), 10);
        assert_eq!(encode_frequency(1001), 10);
    }

    #[test]
    fn b0_matches_the_documented_example() {


        let a = channel(0x0A, [0x00, 0x0A, 0x14, 0x1E]);
        let command = b0(
            0,
            StrengthMode::NoChange,
            StrengthMode::NoChange,
            0,
            0,
            a,
            Channel::default(),
        );
        assert_eq!(
            command,
            [
                0xB0, 0x00, 0x00, 0x00, 0x0A, 0x0A, 0x0A, 0x0A, 0x00, 0x0A, 0x14, 0x1E, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00
            ]
        );
    }

    #[test]
    fn b0_packs_sequence_modes_and_zeroes_bad_slots() {
        let good = channel(20, [50; 4]);
        let bad_freq = Channel {
            freq: [20, 20, 9, 20],
            intensity: [50; 4],
        };
        let command = b0(
            3,
            StrengthMode::Set,
            StrengthMode::Up,
            210,
            20,
            bad_freq,
            good,
        );
        assert_eq!(command[1], 0x3D);
        assert_eq!(command[2], MAX_STRENGTH);
        assert_eq!(command[3], 20);
        assert_eq!(command[4..12], [0; 8]);
        assert_eq!(command[12..20], [20, 20, 20, 20, 50, 50, 50, 50]);

        let bad_intensity = Channel {
            freq: [20; 4],
            intensity: [50, 50, 101, 50],
        };
        let command = b0(
            0,
            StrengthMode::NoChange,
            StrengthMode::NoChange,
            0,
            0,
            bad_intensity,
            Channel::default(),
        );
        assert_eq!(command[4..12], [0; 8]);
    }

    #[test]
    fn bf_carries_limits_and_balances() {
        assert_eq!(
            bf(100, 80, 128, 129, 130, 131),
            [0xBF, 100, 80, 128, 129, 130, 131]
        );
        assert_eq!(bf(255, 0, 0, 0, 0, 0)[1], MAX_STRENGTH);
    }

    #[test]
    fn b1_reads_the_reported_strengths() {
        assert_eq!(
            parse_b1(&[0xB1, 5, 40, 30]),
            Some(B1 {
                seq: 5,
                strength_a: 40,
                strength_b: 30
            })
        );
        assert_eq!(parse_b1(&[0xB1, 0, 12, 0]).map(|r| r.seq), Some(0));
        assert_eq!(parse_b1(&[0xB0, 0, 0, 0]), None);
        assert_eq!(parse_b1(&[0xB1, 1, 2]), None);
    }

    #[test]
    fn a_still_stroke_pulses_nothing() {
        let mut m = CoyoteMapper::new(0, 0);
        let commands = run(&mut m, 40, |_| 0.5, true);
        assert_eq!(commands.len(), 4);
        assert!(
            commands
                .iter()
                .all(|c| c[8..12] == [0; 4] && c[16..20] == [0; 4]),
            "{commands:?}"
        );

        assert!(commands.iter().all(|c| c[4..8] == [100; 4]));
    }

    #[test]
    fn nothing_driving_l0_pulses_nothing() {
        let mut m = CoyoteMapper::new(0, 0);
        let commands = run(&mut m, 40, |i| (i % 2) as f64, false);
        assert!(
            commands
                .iter()
                .all(|c| c[8..12] == [0; 4] && c[16..20] == [0; 4])
        );
    }

    #[test]
    fn a_fast_stroke_raises_intensity_and_shortens_the_period() {
        let mut m = CoyoteMapper::new(0, 0);

        let commands = run(&mut m, 40, |i| if i % 2 == 0 { 0.25 } else { 0.75 }, true);
        let last = commands.last().unwrap();
        assert!(
            last[4..8].iter().all(|f| *f == 20),
            "period {:?}",
            &last[4..8]
        );
        assert!(
            last[8..12].iter().all(|i| *i > 40),
            "A intensity {:?}",
            &last[8..12]
        );
        assert!(
            last[16..20].iter().all(|i| *i > 40),
            "B intensity {:?}",
            &last[16..20]
        );
    }

    #[test]
    fn position_one_puts_everything_on_channel_a() {
        let mut m = CoyoteMapper::new(0, 0);

        let commands = run(&mut m, 40, |i| if i % 2 == 0 { 1.0 } else { 0.999 }, true);
        let last = commands.last().unwrap();
        assert!(
            last[8..12].iter().any(|i| *i > 0),
            "A intensity {:?}",
            &last[8..12]
        );
        assert_eq!(last[16..20], [0; 4]);
    }

    #[test]
    fn strength_ramps_in_steps_and_waits_for_the_reply() {
        let mut m = CoyoteMapper::new(20, 20);

        let commands = run(&mut m, 40, |_| 0.5, true);
        let first = commands[0];
        assert_eq!(first[1] & 0x0F, 0x0F);
        assert_eq!(first[1] >> 4, 1);
        assert_eq!((first[2], first[3]), (STRENGTH_STEP, STRENGTH_STEP));
        assert!(commands[1..].iter().all(|c| c[1] == 0), "{commands:?}");

        m.ack(B1 {
            seq: 1,
            strength_a: 4,
            strength_b: 4,
        });
        let next = run(&mut m, 40, |_| 0.5, true)[0];
        assert_eq!((next[2], next[3]), (2 * STRENGTH_STEP, 2 * STRENGTH_STEP));
        assert_eq!(next[1] >> 4, 2);


        m.ack(B1 {
            seq: 0,
            strength_a: 2,
            strength_b: 2,
        });
        assert_eq!(m.strength(), (2, 2));
    }
}
