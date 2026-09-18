mod clip_runner;

pub(crate) use clip_runner::{Result, check, dom_bridge, metal};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    clip_runner::run(clip_runner::painter::paint_legacy_scene, "legacy").await
}
