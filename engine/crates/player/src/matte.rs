use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, Weak};

use crate::mpv::Mpv;

#[derive(Debug, PartialEq)]
pub struct Matte {
    pub w: u32,
    pub h: u32,
    pub cover: Vec<u8>,
}

pub trait MatteSource: Send + Sync {
    fn matte_at(&self, pts: f64) -> Option<(u64, Arc<Matte>)>;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VrCensor {
    pub blur: bool,
    pub strength: f32,
}

struct Installed {
    source: Option<(Arc<dyn MatteSource>, Weak<Mpv>)>,
    generation: u64,
}

static MASK: Mutex<Installed> = Mutex::new(Installed { source: None, generation: 0 });
static CENSOR: Mutex<(Installed, Option<VrCensor>)> = Mutex::new((Installed { source: None, generation: 0 }, None));

fn put(i: &mut Installed, source: Option<Arc<dyn MatteSource>>, mpv: &Arc<Mpv>) {
    i.source = source.map(|s| (s, Arc::downgrade(mpv)));
    i.generation += 1;
}

pub(crate) fn install(source: Option<Arc<dyn MatteSource>>, mpv: &Arc<Mpv>) {
    put(&mut MASK.lock().unwrap(), source, mpv);
}

pub(crate) fn install_censor(look: Option<VrCensor>, source: Option<Arc<dyn MatteSource>>, mpv: &Arc<Mpv>) {
    let mut c = CENSOR.lock().unwrap();
    c.1 = look;
    put(&mut c.0, source, mpv);
}

pub(crate) type Showing = ((u64, u64), Arc<Matte>);

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn showing() -> Option<Showing> {
    showing_in(&MASK.lock().unwrap())
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn censoring() -> Option<(VrCensor, Option<Showing>)> {
    let c = CENSOR.lock().unwrap();
    let look = c.1?;
    Some((look, showing_in(&c.0)))
}

fn showing_in(i: &Installed) -> Option<Showing> {
    let (source, mpv, generation) = {
        let (source, mpv) = i.source.clone()?;
        (source, mpv.upgrade()?, i.generation)
    };
    let pts = f64::from_bits(mpv.observed_time.load(Ordering::Relaxed));
    let (index, matte) = source.matte_at(pts)?;
    Some(((generation, index), matte))
}
