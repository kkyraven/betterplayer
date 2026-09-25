use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use bp_devices::output::CONNECT_GLIDE_MS;
use bp_devices::ramp::VolumeSettings;
use bp_devices::tcode::{AxisClamp, Profile};
use bp_devices::transport::Transport;
use bp_devices::{Output, Status, TickContext};
use bp_script::Axis;

const SR6_AXES: [Axis; 6] = [Axis::L0, Axis::L1, Axis::L2, Axis::R0, Axis::R1, Axis::R2];

fn line(reader: &mut BufReader<TcpStream>) -> String {
    let mut line = String::new();
    reader.read_line(&mut line).expect("TCode output before timeout");
    assert!(line.ends_with('\n'), "unterminated TCode: {line:?}");
    line
}

#[test]
fn sr6_stream_output_preserves_all_six_axes_ranges_and_timed_moves() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut output = Output::new(1, Transport::Tcp {
        host: "127.0.0.1".into(), port: listener.local_addr().unwrap().port(),
    }, Profile::Stroker);
    for axis in Axis::ALL {
        output.clamps[axis.index()].enabled = SR6_AXES.contains(&axis);
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while !output.connected() {
        output.poll();
        assert!(!matches!(output.snapshot().status, Status::Error(_)), "{:?}", output.snapshot().status);
        assert!(Instant::now() < deadline, "stream connect timed out");
        thread::sleep(Duration::from_millis(1));
    }
    let (board, _) = listener.accept().unwrap();
    board.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let mut board = BufReader::new(board);
    assert_eq!(line(&mut board), "D0\n");
    assert_eq!(line(&mut board), "D1\n");

    let mut values = [0.0; Axis::COUNT];
    let mut driven = [false; Axis::COUNT];
    for (axis, value) in SR6_AXES.into_iter().zip([0.0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
        values[axis.index()] = value;
        driven[axis.index()] = true;
    }
    let mut context = TickContext {
        media_ms: 0.0,
        stroke_next: None,
        playing: true,
        manual_axes: [false; Axis::COUNT],
        estim_manual: false,
        stop_on_pause: true,
        estim_volume: VolumeSettings::default(),
        rate: 1.0,
        interval_ms: 10,
    };
    assert!(output.send(&values, &driven, &context));
    assert_eq!(line(&mut board), format!(
        "L00000I{0} L12000I{0} L24000I{0} R05999I{0} R17999I{0} R29999I{0}\n",
        CONNECT_GLIDE_MS,
    ));
    for (axis, value) in SR6_AXES.into_iter().zip([1.0, 0.8, 0.6, 0.4, 0.2, 0.0]) {
        values[axis.index()] = value;
    }
    let deadline = Instant::now() + Duration::from_millis(u64::from(CONNECT_GLIDE_MS) + 3000);
    while !output.send(&values, &driven, &context) {
        assert!(Instant::now() < deadline, "connect glide never ended");
        thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(line(&mut board), "L09999I10 L17999I10 L25999I10 R04000I10 R12000I10 R20000I10\n");
    assert!(!output.send(&values, &driven, &context), "unchanged positions should hold");

    for (axis, value) in SR6_AXES.into_iter().zip([0.9, 0.7, 0.5, 0.3, 0.1, 0.1]) {
        values[axis.index()] = value;
        assert!(output.send(&values, &driven, &context));
    }
    for expected in ["L08999I10\n", "L16999I10\n", "L25000I10\n", "R03000I10\n", "R11000I10\n", "R21000I10\n"] {
        assert_eq!(line(&mut board), expected);
    }

    output.clamps[Axis::R0.index()] = AxisClamp { enabled: true, min: 0.2, max: 0.8 };
    values[Axis::R0.index()] = 0.0;
    assert!(output.send(&values, &driven, &context));
    assert_eq!(line(&mut board), "R02000I10\n");
    values[Axis::R0.index()] = 1.0;
    assert!(output.send(&values, &driven, &context));
    assert_eq!(line(&mut board), "R07999I10\n");

    output.clamps[Axis::R0.index()].enabled = false;
    values[Axis::R0.index()] = 0.5;
    values[Axis::R1.index()] = 0.7;
    assert!(output.send(&values, &driven, &context));
    assert_eq!(line(&mut board), "R16999I10\n");
    output.clamps[Axis::R0.index()].enabled = true;
    assert!(output.send(&values, &driven, &context));
    assert_eq!(line(&mut board), "R05000I10\n");

    context.playing = false;
    assert!(!output.send(&values, &driven, &context), "pause keeps the six positions");
    output.disconnect();
}
