use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter1, IDXGIDevice, IDXGIFactory1};
use windows::core::Interface;

const VENDOR_NVIDIA: u32 = 0x10DE;



pub const VSR_MIN_DRIVER: f64 = 537.42;

#[derive(Clone, Debug)]
pub struct Gpu {
    pub name: String,
    pub nvidia: bool,

    pub driver: f64,
}



pub fn gpu() -> Result<Gpu, String> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| format!("CreateDXGIFactory1: {e}"))?;
        let mut first: Option<Gpu> = None;
        let mut i = 0;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            i += 1;
            let adapter: IDXGIAdapter1 = adapter;
            let desc = adapter.GetDesc1().map_err(|e| format!("GetDesc1: {e}"))?;

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

        let umd = (32i64 << 48) | (0 << 32) | (15 << 16) | 9186;
        assert_eq!(super::nvidia_driver(umd), 591.86);
    }
}
