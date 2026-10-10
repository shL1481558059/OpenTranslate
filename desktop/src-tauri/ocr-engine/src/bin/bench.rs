use ocr_engine::{preload, recognize_path};
use std::env;
use std::time::Instant;

fn main() {
    let path = env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: ocr-bench <image.png>");
        std::process::exit(2);
    });
    let preload_started = Instant::now();
    if let Err(error) = preload() {
        eprintln!("preload failed: {error}");
        std::process::exit(1);
    }
    let preload_ms = preload_started.elapsed().as_millis();
    let mut last = None;
    for index in 1..=3 {
        let started = Instant::now();
        match recognize_path(std::path::Path::new(&path)) {
            Ok(output) => {
                let wall = started.elapsed().as_millis();
                println!(
                    "run {index}: wall={wall}ms engine={}ms blocks={}",
                    output.elapsed_ms,
                    output.blocks.len()
                );
                for block in &output.blocks {
                    println!(
                        "  [{}] {:?} {}",
                        block.id, block.bbox, block.text.replace('\n', " / ")
                    );
                }
                last = Some(output);
            }
            Err(error) => {
                eprintln!("run {index} failed: {error}");
                std::process::exit(1);
            }
        }
    }
    if let Some(output) = last {
        println!(
            "preload_ms={preload_ms} image={}x{} blocks={}",
            output.image_width, output.image_height, output.blocks.len()
        );
    }
}
