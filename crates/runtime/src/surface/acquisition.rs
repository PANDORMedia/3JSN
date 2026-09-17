use deno_core::{cppgc, v8};
use deno_error::JsErrorBox;
use deno_webgpu::{
    canvas::{Descriptor, GPUCanvasContext},
    texture::{GPUTexture, GPUTextureDimension},
    wgpu_core, wgpu_types,
};

use super::{FrameOutcome, SurfaceBindings};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum AcquiredFrame {
    Surface,
    Discarded,
}

pub(super) fn status_outcome(status: &wgpu_types::SurfaceStatus) -> Result<FrameOutcome, String> {
    use wgpu_types::SurfaceStatus;
    match status {
        SurfaceStatus::Good | SurfaceStatus::Suboptimal => Ok(FrameOutcome::Presented),
        SurfaceStatus::Timeout
        | SurfaceStatus::Occluded
        | SurfaceStatus::Outdated
        | SurfaceStatus::Lost => Ok(FrameOutcome::Retry),
        SurfaceStatus::Validation => Err("surface validation failed".into()),
    }
}

impl SurfaceBindings {
    pub(super) fn current_texture(
        &mut self,
        scope: &mut v8::PinScope<'_, '_>,
    ) -> Result<v8::Global<v8::Object>, JsErrorBox> {
        let context = self
            .context
            .as_ref()
            .ok_or_else(|| JsErrorBox::type_error("native canvas has no context"))?;
        let local = v8::Local::new(scope, context);
        let context = cppgc::try_unwrap_cppgc_object::<GPUCanvasContext>(scope, local.into())
            .expect("only GPUCanvasContext is retained");
        if let Some(texture) = context.current_texture.borrow().as_ref() {
            return Ok(texture.clone());
        }
        if self.reconfigure {
            context.resize(scope);
            self.reconfigure = false;
            self.copy_destination_configured = false;
        }
        let configuration = context.configuration.borrow();
        let configuration = configuration
            .as_ref()
            .ok_or_else(|| JsErrorBox::type_error("GPUCanvasContext has not been configured"))?;
        let descriptor = context.texture_descriptor.borrow();
        let Some(Descriptor::Surface(descriptor)) = descriptor.as_ref() else {
            return Err(JsErrorBox::type_error(
                "native canvas has no surface configuration",
            ));
        };
        let device = &configuration.device;
        let size = wgpu_types::Extent3d {
            width: descriptor.width,
            height: descriptor.height,
            depth_or_array_layers: 1,
        };
        let output = device
            .instance
            .surface_get_current_texture(self.data.borrow().id, None)
            .map_err(|error| JsErrorBox::generic(error.to_string()))?;
        let outcome = status_outcome(&output.status).map_err(JsErrorBox::generic)?;
        let (id, acquired) = if outcome == FrameOutcome::Presented {
            let id = output
                .texture
                .ok_or_else(|| JsErrorBox::generic("surface returned no texture"))?;
            (id, AcquiredFrame::Surface)
        } else {
            // Occlusion can race the OS redraw notification. Let JS finish its
            // callback (including scheduling the next RAF) using a disposable
            // GPU texture, then retry without presenting or counting this frame.
            self.reconfigure |= matches!(
                output.status,
                wgpu_types::SurfaceStatus::Lost | wgpu_types::SurfaceStatus::Outdated
            );
            let (id, error) = device.instance.device_create_texture(
                device.id,
                &wgpu_core::resource::TextureDescriptor {
                    label: Some("3JSN undisplayed canvas frame".into()),
                    size,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu_types::TextureDimension::D2,
                    format: descriptor.format,
                    usage: descriptor.usage | wgpu_types::TextureUsages::COPY_SRC,
                    view_formats: descriptor.view_formats.clone(),
                },
                None,
            );
            device.error_handler.push_error(error);
            (id, AcquiredFrame::Discarded)
        };
        // The flags type is private upstream; its public WebIDL conversion keeps
        // this adapter independent of that representation and validates the bits.
        let usage_value = v8::Integer::new_from_unsigned(scope, descriptor.usage.bits()).into();
        let usage = deno_core::webidl::WebIdlConverter::convert(
            scope,
            usage_value,
            "native canvas texture".into(),
            (|| "usage".into()).into(),
            &Default::default(),
        )
        .map_err(JsErrorBox::from_err)?;
        let texture = GPUTexture {
            instance: device.instance.clone(),
            error_handler: device.error_handler.clone(),
            id,
            device_id: device.id,
            queue_id: device.queue,
            default_view_id: Default::default(),
            label: String::new(),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: GPUTextureDimension::D2,
            format: configuration.format.clone(),
            usage,
        };
        let object = cppgc::make_cppgc_object(scope, texture);
        let object = v8::Global::new(scope, object);
        self.deferred = None;
        self.acquired = Some(acquired);
        context.current_texture.replace(Some(object.clone()));
        Ok(object)
    }
}
