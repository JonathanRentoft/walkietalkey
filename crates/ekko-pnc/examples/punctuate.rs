//! Punctuate text with Ekko PnC.
//!
//!   cargo run --example punctuate -- <model-dir> "hej mit navn er emil hvordan går det"
//!   cargo run --example punctuate -- <model-dir> --json-cases golden.json   (one output per case, as JSON)

use std::time::Instant;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = args.first().ok_or("usage: punctuate <model-dir> <text> | --json-cases <golden.json>")?;
    let t0 = Instant::now();
    let pnc = ekko_pnc::Punctuator::from_dir(dir)?;
    let load = t0.elapsed();
    if args.get(1).map(String::as_str) == Some("--json-cases") {
        let golden: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&args[2])?)?;
        let mut out = serde_json::Map::new();
        for case in golden["cases"].as_array().ok_or("no cases")? {
            let text = pnc.punctuate(case["input"].as_str().unwrap_or_default())?;
            out.insert(case["name"].as_str().unwrap_or_default().to_string(), text.into());
        }
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }
    let text = args[1..].join(" ");
    let t1 = Instant::now();
    let result = pnc.punctuate(&text)?;
    eprintln!("load {:.0} ms, punctuate {:.1} ms", load.as_secs_f64() * 1e3, t1.elapsed().as_secs_f64() * 1e3);
    println!("{result}");
    Ok(())
}
