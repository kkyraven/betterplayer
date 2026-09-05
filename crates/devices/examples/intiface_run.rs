use std::time::{Duration, Instant};
fn main() {
    let server = bp_devices::IntifaceServer::start(12345).expect("bind 12345");
    println!("listening on {}", server.port());
    let mut last = None;
    loop {
        let s = server.status();
        let stroke = server
            .stroke_at(Instant::now())
            .map(|v| (v * 100.0).round() / 100.0);
        let line = format!(
            "clients={} client={:?} stroke={:?}",
            s.clients, s.client, stroke
        );
        if last.as_deref() != Some(line.as_str()) {
            println!("{line}");
            last = Some(line);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
