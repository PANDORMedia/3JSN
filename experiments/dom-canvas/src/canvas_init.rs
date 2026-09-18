use deno_webgpu::{
    Instance,
    texture::{GPUTexture, GPUTextureDimension},
    wgpu_core::{
        command::{LoadOp, RenderPassColorAttachment, RenderPassDescriptor, StoreOp},
        id,
        resource::TextureViewDescriptor,
    },
    wgpu_types,
};

use crate::Result;

/// Submit initialization for an ordinary Deno-created canvas before native export.
///
/// A Load/Store pass asks core's initialization tracker to clear untouched or
/// discarded subresources while preserving initialized pixels. The view requires
/// the original texture's RENDER_ATTACHMENT permission; no usage is added.
/// HAL-imported producer textures and other configured usages are outside scope.
///
/// Success means submitted, not CPU-completed. The caller keeps the cppgc source
/// rooted and serializes producer work, this submission, and the subsequent host
/// snapshot on the same native queue. Expire the source only after that snapshot
/// is submitted. This helper performs no readback or completion wait.
pub fn initialize_for_export(source: &GPUTexture) -> Result<()> {
    let usage: wgpu_types::TextureUsages = source.usage.into();
    if !usage.contains(wgpu_types::TextureUsages::RENDER_ATTACHMENT) {
        return Err("canvas export initialization requires RENDER_ATTACHMENT usage".into());
    }
    if !matches!(source.dimension, GPUTextureDimension::D2)
        || source.size.width == 0
        || source.size.height == 0
        || source.size.depth_or_array_layers != 1
        || source.mip_level_count != 1
        || source.sample_count != 1
    {
        return Err(
            "canvas export initialization requires nonempty 2D texture with one layer, mip and sample"
                .into(),
        );
    }

    let instance = &source.instance;
    instance
        .queue_submit(source.queue_id, &[])
        .map_err(|(_, error)| format!("canvas initialization producer flush failed: {error}"))?;

    let mut temporary = Temporary {
        instance,
        view: None,
        encoder: None,
        command: None,
    };
    let (view, error) = instance.texture_create_view(
        source.id,
        &TextureViewDescriptor {
            label: Some("Canvas export initialization view".into()),
            format: None,
            dimension: Some(wgpu_types::TextureViewDimension::D2),
            usage: Some(wgpu_types::TextureUsages::RENDER_ATTACHMENT),
            range: wgpu_types::ImageSubresourceRange {
                aspect: wgpu_types::TextureAspect::All,
                base_mip_level: 0,
                mip_level_count: Some(1),
                base_array_layer: 0,
                array_layer_count: Some(1),
            },
        },
        None,
    );
    temporary.view = Some(view);
    if let Some(error) = error {
        return Err(format!("canvas initialization view failed: {error}").into());
    }

    let (encoder, error) = instance.device_create_command_encoder(
        source.device_id,
        &wgpu_types::CommandEncoderDescriptor {
            label: Some("Canvas export initialization".into()),
        },
        None,
    );
    temporary.encoder = Some(encoder);
    if let Some(error) = error {
        return Err(format!("canvas initialization encoder failed: {error}").into());
    }
    let (mut pass, error) = instance.command_encoder_begin_render_pass(
        encoder,
        &RenderPassDescriptor {
            label: Some("Preserve canvas contents and initialize missing pixels".into()),
            color_attachments: vec![Some(RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                load_op: LoadOp::Load,
                store_op: StoreOp::Store,
            })]
            .into(),
            ..Default::default()
        },
    );
    if let Some(error) = error {
        return Err(format!("canvas initialization pass failed: {error}").into());
    }
    instance
        .render_pass_end(&mut pass)
        .map_err(|error| format!("canvas initialization pass end failed: {error}"))?;
    drop(pass);

    let (command, error) = instance.command_encoder_finish(
        encoder,
        &wgpu_types::CommandBufferDescriptor {
            label: Some("Canvas export initialization submission".into()),
        },
        None,
    );
    temporary.command = Some(command);
    if let Some((_, error)) = error {
        return Err(format!("canvas initialization finish failed: {error}").into());
    }
    instance
        .queue_submit(source.queue_id, &[command])
        .map_err(|(_, error)| format!("canvas initialization submit failed: {error}"))?;
    Ok(())
}

/// Core allocates registry IDs even for invalid objects; finish and submission
/// do not remove them. Submitted work retains its resources after these drops.
struct Temporary<'a> {
    instance: &'a Instance,
    view: Option<id::TextureViewId>,
    encoder: Option<id::CommandEncoderId>,
    command: Option<id::CommandBufferId>,
}

impl Drop for Temporary<'_> {
    fn drop(&mut self) {
        if let Some(command) = self.command.take() {
            self.instance.command_buffer_drop(command);
        }
        if let Some(encoder) = self.encoder.take() {
            self.instance.command_encoder_drop(encoder);
        }
        if let Some(view) = self.view.take() {
            self.instance.texture_view_drop(view);
        }
    }
}
