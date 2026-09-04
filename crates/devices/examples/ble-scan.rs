//! Lists BLE devices in range. `cargo run -p bp-devices --example ble-scan -- 5`

fn main() {
    let seconds = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(5);
    match bp_devices::ble_scan(seconds) {
        Ok(devices) if devices.is_empty() => println!("nothing advertising"),
        Ok(devices) => {
            for d in devices {
                println!("{:8} {:40} {}", d.kind, d.name, d.address);
            }
        }
        Err(e) => println!("scan failed: {e}"),
    }
}
