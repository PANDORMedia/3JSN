use deno_webgpu::{
    Instance,
    canvas::{Descriptor, GPUCanvasContext},
    texture::GPUTexture,
    wgpu_core::{self, id},
    wgpu_types,
};

use super::{FrameOutcome, SurfaceBindings, status_outcome, surface_error};
use crate::RuntimeError;

/// A GPU-only snapshot, independent of the expired JavaScript canvas texture.
pub(super) struct DeferredFrame {
    instance: Instance,
    texture: id::TextureId,
    device: id::DeviceId,
    queue: id::QueueId,
    size: wgpu_types::Extent3d,
}

impl Drop for DeferredFrame {
    fn drop(&mut self) {
        self.instance.texture_destroy(self.texture);
        self.instance.texture_drop(self.texture);
    }
}

impl DeferredFrame {
    pub(super) fn capture(source: &GPUTexture) -> Result<Option<Self>, RuntimeError> {
        let (texture, error) = source.instance.device_create_texture(
            source.device_id,
            &wgpu_core::resource::TextureDescriptor {
                label: Some("3JSN pending presentation".into()),
                size: source.size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu_types::TextureDimension::D2,
                format: source.format.clone().into(),
                usage: wgpu_types::TextureUsages::COPY_SRC | wgpu_types::TextureUsages::COPY_DST,
                view_formats: vec![],
            },
            None,
        );
        let frame = Self {
            instance: source.instance.clone(),
            texture,
            device: source.device_id,
            queue: source.queue_id,
            size: source.size,
        };
        if let Some(error) = error {
            return Err(surface_error(error));
        }
        if frame.copy_if_live(source.id, texture)? {
            Ok(Some(frame))
        } else {
            // JS may explicitly destroy its current texture to abandon a frame.
            // The private destination is still live, so this is the source.
            Ok(None)
        }
    }

    fn copy_if_live(
        &self,
        source: id::TextureId,
        destination: id::TextureId,
    ) -> Result<bool, RuntimeError> {
        let (encoder, error) = self.instance.device_create_command_encoder(
            self.device,
            &wgpu_types::CommandEncoderDescriptor {
                label: Some("3JSN deferred frame copy".into()),
            },
            None,
        );
        // Core retains submitted resources until completion. Drop registry IDs
        // on every error path too; neither submission nor finish removes them.
        let result = (|| {
            if let Some(error) = error {
                return Err(surface_error(error));
            }
            let image = |texture| wgpu_types::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu_types::Origin3d::ZERO,
                aspect: wgpu_types::TextureAspect::All,
            };
            self.instance
                .command_encoder_copy_texture_to_texture(
                    encoder,
                    &image(source),
                    &image(destination),
                    &self.size,
                )
                .map_err(surface_error)?;
            let (command, error) = self.instance.command_encoder_finish(
                encoder,
                &wgpu_types::CommandBufferDescriptor::default(),
                None,
            );
            let result = if let Some((_, error)) = error {
                match error {
                    wgpu_core::command::CommandEncoderError::DestroyedResource(_) => Ok(false),
                    error => Err(surface_error(error)),
                }
            } else {
                match self.instance.queue_submit(self.queue, &[command]) {
                    Ok(_) => Ok(true),
                    Err((_, wgpu_core::device::queue::QueueSubmitError::DestroyedResource(_))) => {
                        Ok(false)
                    }
                    Err((
                        _,
                        wgpu_core::device::queue::QueueSubmitError::CommandEncoder(
                            wgpu_core::command::CommandEncoderError::DestroyedResource(_),
                        ),
                    )) => Ok(false),
                    Err((_, error)) => Err(surface_error(error)),
                }
            };
            self.instance.command_buffer_drop(command);
            result
        })();
        self.instance.command_encoder_drop(encoder);
        result
    }
}

impl SurfaceBindings {
    pub(super) fn present_deferred(
        &mut self,
        context: &GPUCanvasContext,
    ) -> Result<FrameOutcome, RuntimeError> {
        let Some(pending) = &self.deferred else {
            return Ok(FrameOutcome::NoFrame);
        };
        let configuration = context.configuration.borrow();
        let configuration = configuration
            .as_ref()
            .ok_or_else(|| surface_error("pending frame has no canvas configuration"))?;
        let descriptor = context.texture_descriptor.borrow();
        let Some(Descriptor::Surface(descriptor)) = descriptor.as_ref() else {
            return Err(surface_error("pending frame has no surface descriptor"));
        };
        let data = self.data.borrow();
        let device = &configuration.device;
        if device.id != pending.device {
            return Err(surface_error("pending frame belongs to a different device"));
        }
        if !self.copy_destination_configured || self.reconfigure {
            let capabilities = data
                .instance
                .surface_get_capabilities(data.id, device.adapter)
                .map_err(surface_error)?;
            if !capabilities
                .usages
                .contains(wgpu_types::TextureUsages::COPY_DST)
            {
                return Err(surface_error(
                    "surface cannot restore a deferred frame: COPY_DST is unsupported",
                ));
            }
            let mut native_descriptor = descriptor.clone();
            native_descriptor.usage |= wgpu_types::TextureUsages::COPY_DST;
            if let Some(error) =
                data.instance
                    .surface_configure(data.id, device.id, &native_descriptor)
            {
                return Err(surface_error(error));
            }
            // Keep the internal capability until explicit application resize or
            // configuration. The JS descriptor and texture usage stay unchanged.
            self.copy_destination_configured = true;
            self.reconfigure = false;
        }
        let output = data
            .instance
            .surface_get_current_texture(data.id, None)
            .map_err(surface_error)?;
        let outcome = status_outcome(&output.status).map_err(surface_error)?;
        if outcome == FrameOutcome::Retry {
            self.reconfigure |= matches!(
                output.status,
                wgpu_types::SurfaceStatus::Lost | wgpu_types::SurfaceStatus::Outdated
            );
            return Ok(outcome);
        }
        let texture = output
            .texture
            .ok_or_else(|| surface_error("surface returned no deferred-frame destination"))?;
        let result = match pending.copy_if_live(pending.texture, texture) {
            Ok(true) => data
                .instance
                .surface_present(data.id)
                .map_err(surface_error),
            copy => {
                // Drain the acquired slot before reporting the copy failure.
                let _ = data.instance.surface_texture_discard(data.id);
                Err(copy.err().unwrap_or_else(|| {
                    surface_error("deferred presentation texture was destroyed")
                }))
            }
        };
        data.instance.texture_destroy(texture);
        data.instance.texture_drop(texture);
        let status = result?;
        let outcome = status_outcome(&status).map_err(surface_error)?;
        self.reconfigure |= matches!(
            status,
            wgpu_types::SurfaceStatus::Lost | wgpu_types::SurfaceStatus::Outdated
        );
        if outcome == FrameOutcome::Presented {
            self.deferred = None;
            self.presented_frames += 1;
        }
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use deno_core::{cppgc, v8};

    use super::*;
    use crate::Runtime;

    async fn evaluate(runtime: &mut Runtime, source: &'static str) -> v8::Global<v8::Value> {
        let value = runtime
            .js
            .execute_script("deferred-frame-test.js", source)
            .unwrap();
        let result = runtime.js.resolve(value);
        runtime
            .js
            .with_event_loop_promise(result, Default::default())
            .await
            .unwrap()
    }

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "requires an actual native GPU; readback validates the retained copy only"]
    async fn deferred_gpu_snapshot_survives_js_expiry_and_rejects_destroyed_source() {
        let mut runtime = Runtime::new();
        let source = evaluate(&mut runtime, r#"(async () => {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter || adapter.info.isFallbackAdapter) throw new Error('hardware GPU required');
            globalThis.device = await adapter.requestDevice();
            device.addEventListener('uncapturederror', event => { throw new Error(`unexpected GPU error: ${event.error.message}`); });
            globalThis.source = device.createTexture({size: [4, 4], format: 'rgba8unorm',
                usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST});
            globalThis.destination = device.createTexture({size: [4, 4], format: 'rgba8unorm',
                usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST});
            globalThis.expected = Uint8Array.from({length: 64}, (_, i) => (i * 29 + 7) % 256);
            device.queue.writeTexture({texture: source}, expected, {bytesPerRow: 16}, [4, 4]);
            return source;
        })()"#).await;
        let destination = runtime
            .js
            .execute_script("destination.js", "destination")
            .unwrap();
        let pending = {
            deno_core::scope!(scope, runtime.js);
            let source = v8::Local::new(scope, &source);
            let source = cppgc::try_unwrap_cppgc_object::<GPUTexture>(scope, source).unwrap();
            let pending = DeferredFrame::capture(&source)
                .unwrap()
                .expect("live source");
            source.instance.texture_destroy(source.id);
            assert!(
                DeferredFrame::capture(&source).unwrap().is_none(),
                "explicitly destroyed source is abandoned"
            );
            let destination = v8::Local::new(scope, &destination);
            let destination =
                cppgc::try_unwrap_cppgc_object::<GPUTexture>(scope, destination).unwrap();
            assert!(
                pending
                    .copy_if_live(pending.texture, destination.id)
                    .unwrap()
            );
            pending
        };
        // Destruction immediately after submit must not free in-flight GPU data.
        drop(pending);
        evaluate(&mut runtime, r#"(async () => {
            const buffer = device.createBuffer({size: 1024, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({texture: destination}, {buffer, bytesPerRow: 256}, [4, 4]);
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const bytes = new Uint8Array(buffer.getMappedRange());
            for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) {
                if (bytes[y * 256 + x] !== expected[y * 16 + x]) throw new Error('retained GPU content mismatch');
            }
            buffer.unmap(); buffer.destroy();
            device.pushErrorScope('validation');
            source.createView();
            const expired = await device.popErrorScope();
            if (!(expired instanceof GPUValidationError) || !/destroyed/i.test(expired.message)) throw new Error('retained JS source did not expire');
            console.log(JSON.stringify({deferredGpuSnapshot: true, checkedBytes: 64, expiredJsSource: true}));
        })()"#).await;
        let pending = {
            deno_core::scope!(scope, runtime.js);
            let destination = v8::Local::new(scope, &destination);
            let destination =
                cppgc::try_unwrap_cppgc_object::<GPUTexture>(scope, destination).unwrap();
            DeferredFrame::capture(&destination).unwrap().unwrap()
        };
        evaluate(&mut runtime, "device.destroy()").await;
        assert!(
            pending
                .copy_if_live(pending.texture, pending.texture)
                .is_err(),
            "lost device fails explicitly"
        );
        drop(pending);
        drop(source);
        drop(destination);
    }
}
