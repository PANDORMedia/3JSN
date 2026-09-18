use std::{path::Path, rc::Rc, sync::Arc, time::Duration};

use deno_core::{FsModuleLoader, JsRuntime, RuntimeOptions, cppgc, serde_v8, v8};
use deno_webgpu::{
    device::GPUDevice,
    texture::{GPUTexture, GPUTextureDimension, GPUTextureFormat},
};
use serde::de::DeserializeOwned;

use crate::{Result, metal::MetalBridge};

deno_core::extension!(
    interop_globals,
    deps = [deno_webidl, deno_web, deno_webgpu],
    options = { instance: deno_webgpu::Instance },
    state = |state, options| state.put(options.instance),
);

pub fn create_with_dom_extension(
    dom: deno_core::Extension,
    extensions: Vec<deno_core::Extension>,
    prepare: impl Fn(&mut deno_core::Extension),
) -> JsRuntime {
    let instance = Arc::new(deno_webgpu::wgpu_core::global::Global::new(
        "3JSN shared Metal queue probe",
        wgpu_types::InstanceDescriptor {
            backends: wgpu_types::Backends::METAL,
            flags: wgpu_types::InstanceFlags::VALIDATION,
            ..wgpu_types::InstanceDescriptor::new_without_display_handle()
        },
        None,
    ));
    let mut globals = interop_globals::init(instance);
    globals.esm_entry_point = Some("ext:interop_globals/web-globals.js");
    globals.esm_files = vec![deno_core::ExtensionFileSource::new(
        "ext:interop_globals/web-globals.js",
        deno_core::ascii_str_include!("../../../crates/runtime/src/web-globals.js"),
    )]
    .into();
    let mut installed = vec![
        deno_webidl::deno_webidl::init(),
        deno_web::deno_web::init(
            Arc::new(deno_web::BlobStore::default()),
            None,
            false,
            deno_web::InMemoryBroadcastChannel::default(),
        ),
        deno_webgpu::deno_webgpu::init(),
        globals,
        dom,
    ];
    installed.extend(extensions);
    installed.iter_mut().for_each(prepare);
    JsRuntime::new(RuntimeOptions {
        module_loader: Some(Rc::new(FsModuleLoader)),
        extensions: installed,
        ..Default::default()
    })
}

pub async fn load(runtime: &mut JsRuntime, path: &Path) -> Result<()> {
    let specifier = deno_core::ModuleSpecifier::from_file_path(path.canonicalize()?)
        .map_err(|_| "invalid application module path")?;
    let id = runtime.load_main_es_module(&specifier).await?;
    let evaluation = runtime.mod_evaluate(id);
    tokio::time::timeout(
        Duration::from_secs(30),
        runtime.with_event_loop_promise(evaluation, Default::default()),
    )
    .await??;
    Ok(())
}

pub async fn evaluate<T: DeserializeOwned>(runtime: &mut JsRuntime, source: String) -> Result<T> {
    let value = runtime.execute_script("probe:evaluate", source)?;
    let result = runtime.resolve(value);
    let value = tokio::time::timeout(
        Duration::from_secs(30),
        runtime.with_event_loop_promise(result, Default::default()),
    )
    .await??;
    deno_core::scope!(scope, runtime);
    let value = v8::Local::new(scope, value);
    Ok(serde_v8::from_v8(scope, value)?)
}

pub fn with_device<T>(
    runtime: &mut JsRuntime,
    apply: impl FnOnce(&GPUDevice) -> Result<T>,
) -> Result<T> {
    let root = runtime.execute_script("probe:device", "probe.device")?;
    deno_core::scope!(scope, runtime);
    let value = v8::Local::new(scope, &root);
    let device = cppgc::try_unwrap_cppgc_object::<GPUDevice>(scope, value)
        .ok_or("probe.device is not a native GPUDevice")?;
    apply(&device)
}

/// The caller has completed initialization and retains the producer texture
/// through all subsequent commands. Both registries submit on one native queue.
pub unsafe fn expose_texture(
    runtime: &mut JsRuntime,
    bridge: &MetalBridge,
    texture: &wgpu::Texture,
    descriptor: &wgpu::TextureDescriptor<'_>,
) -> Result<()> {
    let root = runtime.execute_script("probe:device", "probe.device")?;
    deno_core::scope!(scope, runtime);
    let value = v8::Local::new(scope, &root);
    let device = cppgc::try_unwrap_cppgc_object::<GPUDevice>(scope, value)
        .ok_or("probe.device is not a native GPUDevice")?;
    // Convert the private upstream flags type before allocating an imported ID.
    let usage_value = v8::Integer::new_from_unsigned(scope, descriptor.usage.bits()).into();
    let usage = deno_core::webidl::WebIdlConverter::convert(
        scope,
        usage_value,
        "shared UI texture".into(),
        (|| "usage".into()).into(),
        &Default::default(),
    )?;
    // SAFETY: the caller guarantees initialized contents and serialized access.
    // The returned ID moves immediately into one cppgc owner, including on a
    // later property-assignment failure. It is never dropped separately.
    let id = unsafe { bridge.import_texture_to_deno(texture, descriptor)? };
    let object = cppgc::make_cppgc_object(
        scope,
        GPUTexture {
            instance: device.instance.clone(),
            error_handler: device.error_handler.clone(),
            id,
            device_id: device.id,
            queue_id: device.queue,
            default_view_id: Default::default(),
            label: "Shared Vello UI".into(),
            size: descriptor.size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: GPUTextureDimension::D2,
            format: GPUTextureFormat::Rgba8unorm,
            usage,
        },
    );
    let global = scope.get_current_context().global(scope);
    let key = v8::String::new(scope, "uiTexture").ok_or("cannot allocate texture property")?;
    if global.set(scope, key.into(), object.into()) != Some(true) {
        return Err("cannot expose imported UI texture".into());
    }
    Ok(())
}
