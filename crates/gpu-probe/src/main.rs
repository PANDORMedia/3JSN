use std::error::Error;

fn main() -> Result<(), Box<dyn Error>> {
    pollster::block_on(probe())
}

async fn probe() -> Result<(), Box<dyn Error>> {
    let backends = if cfg!(target_os = "macos") {
        wgpu::Backends::METAL
    } else if cfg!(target_os = "windows") {
        wgpu::Backends::DX12
    } else if cfg!(target_os = "linux") {
        wgpu::Backends::VULKAN
    } else {
        return Err("This diagnostic currently targets macOS, Windows, and Linux.".into());
    };
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends,
        ..Default::default()
    });
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
        })
        .await?;
    let info = adapter.get_info();
    if info.device_type == wgpu::DeviceType::Cpu {
        return Err("Software adapter detected; hardware evidence requires a real GPU.".into());
    }
    let (device, _queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("3JSN native device probe"),
            ..Default::default()
        })
        .await?;

    println!("3JSN Rust GPU device probe");
    println!("Adapter: {}", info.name);
    println!("Backend: {:?}", info.backend);
    println!("Device type: {:?}", info.device_type);
    println!("Driver: {} {}", info.driver, info.driver_info);
    println!(
        "Max texture dimension: {}",
        device.limits().max_texture_dimension_2d
    );
    println!("PASS: Rust created a native GPU device.");
    println!("Scope: no window, drawing, V8, or Three.js integration yet.");
    device.destroy();
    Ok(())
}
