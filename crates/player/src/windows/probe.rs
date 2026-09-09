//! What the GPU can do, from DXGI: the adapter vendor and the display driver version.
//! No D3D device is created, so this is cheap enough to run once at player start.

use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter1, IDXGIDevice, IDXGIFactory1};
use windows::core::Interface;

const VENDOR_NVIDIA: u32 = 0x10DE;

/// RTX Video Super Resolution 1.5 brought the 20 series in. Above the Optical Flow SDK 5.0
/// floor (522.25), so one gate covers frame generation too.
pub const VSR_MIN_DRIVER: f64 = 537.42;

#[derive(Clone, Debug)]
pub struct Gpu {
    pub name: String,
    pub nvidia: bool,
    /// NVIDIA's marketing driver number (537.42), 0 when not readable.
    pub driver: f64,
}

/// The NVIDIA adapter when there is one (the RTX features live there even when an integrated GPU
/// is listed first, as on laptops), else the first hardware adapter DXGI lists.
pub fn gpu() -> Result<Gpu, String> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| format!("CreateDXGIFactory1: {e}"))?;
        let mut first: Option<Gpu> = None;
        let mut i = 0;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            i += 1;
            let adapter: IDXGIAdapter1 = adapter;
            let desc = adapter.GetDesc1().map_err(|e| format!("GetDesc1: {e}"))?;
            // Flag 2 is DXGI_ADAPTER_FLAG_SOFTWARE: the Basic Render Driver, not a GPU.
            if desc.Flags & 2 != 0 {
                continue;
            }
            let end = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
            let name = String::from_utf16_lossy(&desc.Description[..end]);
            let nvidia = desc.VendorId == VENDOR_NVIDIA;
            let driver = if nvidia { adapter.CheckInterfaceSupport(&IDXGIDevice::IID).map(nvidia_driver).unwrap_or(0.0) } else { 0.0 };
            let gpu = Gpu { name, nvidia, driver };
            if nvidia {
                return Ok(gpu);
            }
            first.get_or_insert(gpu);
        }
        first.ok_or_else(|| "no display adapter".to_string())
    }
}

/// The user-mode driver version DXGI reports is four 16-bit fields (31.0.15.3742); NVIDIA's
/// number is the last digit of the third and all of the fourth: 5.3742 is 537.42.
fn nvidia_driver(umd: i64) -> f64 {
    let third = ((umd >> 16) & 0xffff) as f64;
    let fourth = (umd & 0xffff) as f64;
    ((third % 10.0) * 10000.0 + fourth) / 100.0
}

#[cfg(test)]
mod tests {
    #[test]
    fn driver_number_from_umd_version() {
        let umd = (31i64 << 48) | (0 << 32) | (15 << 16) | 3742;
        assert_eq!(super::nvidia_driver(umd), 537.42);
        // 32.0.15.9186 is what the 4090 in the first Windows machine reported for driver 591.86.
        let umd = (32i64 << 48) | (0 << 32) | (15 << 16) | 9186;
        assert_eq!(super::nvidia_driver(umd), 591.86);
    }
}
