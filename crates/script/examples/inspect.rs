use bp_script::{find_scripts, heatmap};

fn main() {
    let path = std::env::args().nth(1).expect("media path");
    for s in find_scripts(std::path::Path::new(&path)) {
        let st = heatmap::speed_stats(&s.script);
        println!(
            "{} {:<8} {:>6} actions {:>8.1} s  avg {:>5.0} max {:>5.0}  chapters {} bookmarks {}  {}",
            s.axis,
            s.container.as_str(),
            s.script.actions.len(),
            s.script.duration_ms() / 1000.0,
            st.average,
            st.max,
            s.script.chapters.len(),
            s.script.bookmarks.len(),
            s.source.display()
        );
    }
}
