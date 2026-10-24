//! Writes packages/protocol/test-vectors.json.
//!
//! cargo run --example gen_test_vectors --features test-utils [-- <output path>]

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        concat!(env!("CARGO_MANIFEST_DIR"), "/../test-vectors.json").to_string()
    });
    let value = wt_protocol::test_vectors::generate();
    let mut text = serde_json::to_string_pretty(&value).expect("serializes");
    text.push('\n');
    std::fs::write(&path, text).expect("write test vectors");
    eprintln!("wrote {path}");
}
