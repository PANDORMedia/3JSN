use std::path::Path;

use deno_core::JsRuntime;
use serde_json::{Value, json};
use vello::peniko::ImageData;

use crate::{
    Result, canvas_texture::CanvasImage, check, dom_bridge, evidence, host, painter::Painter,
};

pub struct Session {
    pub painter: Painter,
    output: wgpu::Texture,
    image: Option<CanvasImage>,
    registration: Option<ImageData>,
    frames: usize,
    snapshot_bytes: u64,
}

impl Session {
    pub fn new(painter: Painter) -> Result<Self> {
        let output = painter
            .bridge
            .device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("DOM with embedded canvas"),
                size: wgpu::Extent3d {
                    width: 448,
                    height: 256,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
        Ok(Self {
            painter,
            output,
            image: None,
            registration: None,
            frames: 0,
            snapshot_bytes: 0,
        })
    }

    fn retire_canvas(&mut self) -> Result<()> {
        self.painter.bridge.drain()?;
        if let Some(image) = self.registration.take() {
            self.painter.unregister_canvas(image)?;
        }
        self.image = None;
        Ok(())
    }

    /// The caller has drained both registries; this method submits no new work.
    pub fn release(&mut self) -> Result<()> {
        if let Some(image) = self.registration.take() {
            self.painter.unregister_canvas(image)?;
        }
        self.image = None;
        self.output.destroy();
        self.painter.check_errors()
    }

    fn snapshot(
        &mut self,
        runtime: &mut JsRuntime,
        recreate: bool,
        premultiplied: bool,
    ) -> Result<()> {
        host::with_device(runtime, |device| {
            device
                .instance
                .queue_submit(device.queue, &[])
                .map_err(|error| format!("Deno queue flush: {error:?}"))?;
            Ok(())
        })?;
        if recreate {
            self.retire_canvas()?;
            self.image = Some(dom_bridge::with_texture(runtime, "scene", |source| {
                CanvasImage::new(&self.painter.bridge, source)
            })?);
        }
        let image = self.image.as_mut().ok_or("missing canvas snapshot")?;
        dom_bridge::with_texture(runtime, "scene", |source| {
            // SAFETY: the trusted fixture submitted a full attachment clear in
            // Three.js render or clearColor. Its pending writes were flushed
            // above. This call is serialized on the checked identical queue,
            // with the V8 texture rooted until the snapshot submit completes.
            unsafe { image.update(&self.painter.bridge, source, premultiplied) }
        })?;
        self.snapshot_bytes +=
            u64::from(image.texture.width()) * u64::from(image.texture.height()) * 4;
        if self.registration.is_none() {
            self.registration = Some(dom_bridge::with_document(runtime, |doc| {
                let node = doc
                    .get_element_by_id("scene")
                    .ok_or("scene canvas missing")?;
                self.painter
                    .register_canvas(doc, node, image.texture.clone())
            })?);
        }
        self.painter
            .mark_canvas_dirty(self.registration.as_ref().unwrap())?;
        self.frames += 1;
        dom_bridge::expire(runtime);
        Ok(())
    }

    async fn render_batch(
        &mut self,
        runtime: &mut JsRuntime,
        start: f64,
        recreate: bool,
    ) -> Result<()> {
        for frame in 0..4 {
            host::evaluate::<()>(
                runtime,
                format!("probe.render({})", start + frame as f64 * 0.15),
            )
            .await?;
            self.snapshot(runtime, recreate && frame == 0, true)?;
            self.paint(runtime)?;
            if self.frames == 2
                && std::env::var_os("THREEJS_NATIVE_CANVAS_INJECT_FAILURE").is_some()
            {
                return Err("EXPECTED_FAILURE_AFTER_SUBMIT".into());
            }
        }
        Ok(())
    }

    fn paint(&mut self, runtime: &mut JsRuntime) -> Result<Value> {
        dom_bridge::with_document(runtime, |doc| self.painter.paint(doc, &self.output))
    }

    fn capture(
        &mut self,
        runtime: &mut JsRuntime,
        output: &Path,
        name: &str,
    ) -> Result<(Value, Vec<u8>)> {
        let layout = self.paint(runtime)?;
        let pixels = evidence::read(&self.painter.bridge, &self.output)?;
        self.painter.check_errors()?;
        evidence::expect(&pixels, 4, 4, [12, 16, 24, 255])?;
        let file = format!("{name}.png");
        let report = evidence::save(&output.join(&file), &pixels)?;
        Ok((
            json!({"name":name,"file":file,"layout":layout,"pixels":report}),
            pixels,
        ))
    }
}

pub async fn run(runtime: &mut JsRuntime, session: &mut Session, output: &Path) -> Result<Value> {
    host::evaluate::<()>(runtime, "probe.start()".into()).await?;
    session.render_batch(runtime, 0.2, true).await?;
    let configuration: Value = host::evaluate(runtime, "probe.configuration()".into()).await?;
    let mut captures = vec![];
    let (above, first) = session.capture(runtime, output, "html-above")?;
    evidence::expect(&first, 50, 50, [255, 128, 0, 255])?;
    evidence::expect(&first, 30, 30, [16, 21, 34, 255])?;
    check(
        above["layout"]["canvases"][0]["rect"]
            == json!({"x":24.0,"y":24.0,"width":256.0,"height":160.0}),
        "CSS canvas rectangle differs",
    )?;
    captures.push(above);

    let expiry: Value = host::evaluate(runtime, "probe.assertExpired()".into()).await?;
    check(expiry == true, "host expiry left JS texture usable")?;
    session.render_batch(runtime, 0.8, false).await?;
    let (animated, second) = session.capture(runtime, output, "animated")?;
    let changed = first
        .chunks_exact(4)
        .zip(second.chunks_exact(4))
        .filter(|(a, b)| a != b)
        .count();
    check(
        changed > 1000,
        "canvas image did not refresh after Three.js animation",
    )?;
    captures.push(animated);

    host::evaluate::<()>(
        runtime,
        "document.getElementById('cover').style.zIndex = '1'".into(),
    )
    .await?;
    let (below, pixels) = session.capture(runtime, output, "html-below")?;
    evidence::expect(&pixels, 50, 50, [16, 21, 34, 255])?;
    captures.push(below);

    host::evaluate::<()>(runtime, "probe.resize(400,240); probe.render(1.4)".into()).await?;
    let mismatch = match dom_bridge::with_texture(runtime, "scene", |source| {
        // SAFETY: full initialized render is submitted; descriptor rejection
        // occurs before any import. No native work is expected from this call.
        unsafe {
            session
                .image
                .as_mut()
                .unwrap()
                .update(&session.painter.bridge, source, true)
        }
    }) {
        Ok(()) => return Err("resized texture was accepted by an old snapshot".into()),
        Err(error) => error.to_string(),
    };
    check(
        mismatch == "canvas dimensions or format changed; recreate CanvasImage before updating",
        "wrong resize rejection",
    )?;
    session.snapshot(runtime, true, true)?;
    session.render_batch(runtime, 1.4, false).await?;
    let (resized, before_detach) = session.capture(runtime, output, "bitmap-resized")?;
    check(
        resized["layout"]["canvases"][0]["imageSize"] == json!({"width":400,"height":240})
            && resized["layout"]["canvases"][0]["rect"]["width"] == 256.0,
        "bitmap resize changed CSS layout",
    )?;
    captures.push(resized);

    host::evaluate::<()>(runtime, "probe.detach()".into()).await?;
    let (detached, pixels) = session.capture(runtime, output, "detached")?;
    evidence::expect(&pixels, 30, 30, [12, 16, 24, 255])?;
    check(
        detached["layout"]["canvases"] == json!([]),
        "detached canvas still paints",
    )?;
    captures.push(detached);
    host::evaluate::<()>(runtime, "probe.attach()".into()).await?;
    dom_bridge::with_document(runtime, |doc| {
        let node = doc
            .get_element_by_id("scene")
            .ok_or("reattached canvas missing")?;
        session
            .painter
            .attach_canvas(doc, node, session.registration.as_ref().unwrap())
    })?;
    let (reattached, pixels) = session.capture(runtime, output, "reattached")?;
    check(
        pixels == before_detach,
        "reattaching did not preserve every canvas/DOM pixel",
    )?;
    captures.push(reattached);

    host::evaluate::<()>(runtime, "const canvas = document.getElementById('scene'); canvas.style.width = '200px'; canvas.style.height = '100px'".into()).await?;
    let (css, pixels) = session.capture(runtime, output, "css-resized")?;
    evidence::expect(&pixels, 240, 150, [12, 16, 24, 255])?;
    check(
        css["layout"]["canvases"][0]["contentSize"] == json!({"width":200.0,"height":100.0})
            && css["layout"]["canvases"][0]["imageSize"] == json!({"width":400,"height":240}),
        "CSS resize altered canvas bitmap",
    )?;
    captures.push(css);
    let mut alpha_conversions = vec![];
    for (mode, expected, straight) in [
        ("premultiplied", [6, 136, 12, 255], [0, 255, 0, 128]),
        ("opaque", [0, 128, 0, 255], [0, 128, 0, 255]),
    ] {
        host::evaluate::<()>(runtime, format!("probe.clearColor('{mode}')")).await?;
        session.snapshot(runtime, false, mode == "premultiplied")?;
        let converted = evidence::read(
            &session.painter.bridge,
            &session.image.as_ref().unwrap().texture,
        )?;
        check(
            converted[..4] == straight,
            "canvas alpha conversion differs before DOM paint",
        )?;
        alpha_conversions.push(json!({"mode":mode,"straightRgba":&converted[..4]}));
        let (alpha, pixels) = session.capture(runtime, output, mode)?;
        evidence::expect(&pixels, 100, 100, expected)?;
        captures.push(alpha);
    }

    host::evaluate::<()>(runtime, "canvas.style.width = '256px'; canvas.style.height = '160px'; canvas.style.left = '340px'; probe.render(1.85)".into()).await?;
    session.snapshot(runtime, false, true)?;
    let (clipped, pixels) = session.capture(runtime, output, "clipped-hoisted")?;
    evidence::expect(&pixels, 350, 30, [16, 21, 34, 255])?;
    let expected = [255, 255, 255, 255];
    let actual = evidence::pixel(&pixels, 400, 100).to_vec();
    let clipping = json!({"name":"ancestor overflow clips hoisted canvas","passed":actual == expected,
        "sample":[400,100],"expected":expected,"actual":actual});
    captures.push(clipped);
    // This control identifies Blitz's lost ancestor clip when a positioned
    // child is hoisted. It is not a source rewrite or a compatibility fix.
    host::evaluate::<()>(
        runtime,
        "document.getElementById('stage').style.zIndex = '0'".into(),
    )
    .await?;
    let (contained, pixels) = session.capture(runtime, output, "clipped-stacking-context")?;
    evidence::expect(&pixels, 350, 30, [16, 21, 34, 255])?;
    evidence::expect(&pixels, 390, 30, expected)?;
    evidence::expect(&pixels, 400, 100, expected)?;
    captures.push(contained);

    host::evaluate::<()>(
        runtime,
        "canvas.style.left = '24px'; probe.clearColor('premultiplied')".into(),
    )
    .await?;
    session.snapshot(runtime, false, true)?;
    let (isolated, pixels) = session.capture(runtime, output, "alpha-stacking-context")?;
    evidence::expect(&pixels, 100, 100, [6, 136, 12, 255])?;
    captures.push(isolated);
    host::evaluate::<()>(
        runtime,
        "document.getElementById('stage').style.zIndex = 'auto'".into(),
    )
    .await?;
    let (demoted, pixels) = session.capture(runtime, output, "alpha-after-demotion")?;
    let expected = [6, 136, 12, 255];
    let actual = evidence::pixel(&pixels, 100, 100).to_vec();
    let stacking_mutation = json!({"name":"stacking context demotion paints canvas once","passed":actual.iter().zip(expected).all(|(a,b)| a.abs_diff(b) <= 2),
        "sample":[100,100],"expected":expected,"actual":actual});
    captures.push(demoted);
    session.painter.drain()?;
    let errors: Value = host::evaluate(runtime, "probe.errors".into()).await?;
    check(
        errors == json!([]),
        "Deno GPU errors during canvas painting",
    )?;
    Ok(
        json!({"captures":captures,"clipping":clipping,"stackingMutation":stacking_mutation,"alphaConversions":alpha_conversions,"configuration":configuration,"changedAnimationPixels":changed,"submittedCanvasFrames":session.frames,
        "snapshotCopyBytes":session.snapshot_bytes,"descriptorMismatchRejected":true,
        "hostExpiryRejectedByJsValidation":true,"reinsertedPixelsIdentical":true,"validationErrors":errors}),
    )
}
