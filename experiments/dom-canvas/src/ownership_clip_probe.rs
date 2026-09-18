mod clip_runner;

pub(crate) use clip_runner::{Result, check, dom_bridge, metal};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    clip_runner::run(
        |scene, doc, scale, width, height, limits| {
            blitz_paint::paint_scene_with_ownership(
                &mut anyrender_vello::VelloScenePainter::new(scene),
                doc,
                scale,
                width,
                height,
                0,
                0,
                limits,
            )?;
            Ok(())
        },
        "ownership",
    )
    .await
}
