// NoteBoard Windows 剪贴板原生写入（图片位图 / 文件列表）
//
// 不使用 arboard 的 Windows 实现，原因：
//   1. 它先打开并清空剪贴板，再在持有剪贴板期间把整张图编码成 PNG：大图要数秒
//      （调试构建更慢），期间系统与其他程序都无法访问剪贴板；
//   2. 它以 NULL 作为剪贴板所有者打开。按微软文档，此时 EmptyClipboard 会让后续
//      SetClipboardData 失败，用户实测报错「线程没有打开的剪贴板（os error 1418）」。
// 这里的做法：
//   - 所有数据在打开剪贴板之前写入全局内存块，打开后只做 EmptyClipboard + SetClipboardData，
//     剪贴板仅被占用微秒级时间；
//   - 以调用方窗口为所有者打开剪贴板；
//   - 不做任何编码：解码后的 RGBA 在拷入全局内存时顺带转为 CF_DIBV5 需要的自下而上 BGRA；
//     原图是 PNG 时另附原始字节作为 "PNG" 格式（保留透明度，浏览器 / Office 优先读取）。

use std::time::Duration;

use windows::core::w;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

/// 标准剪贴板格式编号（windows crate 中位于 Ole 模块，直接写常量以免引入额外特性）
const CF_HDROP: u32 = 15;
const CF_DIBV5: u32 = 17;

/// BITMAPV5HEADER 的固定长度
const DIBV5_HEADER_SIZE: usize = 124;
/// DROPFILES 的固定长度（pFiles、pt.x、pt.y、fNC、fWide 各 4 字节）
const DROPFILES_SIZE: usize = 20;
/// 打开剪贴板的等待上限：剪贴板历史、截图工具等会在内容变化后立即打开剪贴板读取，
/// 上一张大图（数十 MB）可能要读几百毫秒，连续复制时需要等它们读完
const OPEN_TIMEOUT: Duration = Duration::from_secs(2);

/// 生成 32 位带透明通道的 BITMAPV5HEADER（像素按行自下而上存放）。
/// 高度取正值：MS Word / 写字板无法粘贴负高度（自上而下）的位图。
pub fn dibv5_header(width: u32, height: u32) -> [u8; DIBV5_HEADER_SIZE] {
    // BI_BITFIELDS：用下方掩码描述 BGRA 各通道位置；LCS_sRGB：按 sRGB 解释颜色
    const BI_BITFIELDS: u32 = 3;
    const LCS_SRGB: u32 = 0x7352_4742;
    const LCS_GM_IMAGES: u32 = 4;

    let mut header = [0u8; DIBV5_HEADER_SIZE];
    let mut put = |offset: usize, value: u32| header[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    put(0, DIBV5_HEADER_SIZE as u32); // bV5Size
    put(4, width); // bV5Width
    put(8, height); // bV5Height（正值 = 自下而上）
    put(12, 1 | (32 << 16)); // bV5Planes = 1、bV5BitCount = 32（两个 u16 合写）
    put(16, BI_BITFIELDS); // bV5Compression
    put(20, width.wrapping_mul(height).wrapping_mul(4)); // bV5SizeImage
    put(40, 0x00FF_0000); // bV5RedMask
    put(44, 0x0000_FF00); // bV5GreenMask
    put(48, 0x0000_00FF); // bV5BlueMask
    put(52, 0xFF00_0000); // bV5AlphaMask
    put(56, LCS_SRGB); // bV5CSType；其后端点与伽马（60..108）保持 0
    put(108, LCS_GM_IMAGES); // bV5Intent；配置文件与保留字段保持 0
    header
}

/// 生成 CF_HDROP 数据：DROPFILES 头 + 以 \0 结尾的 UTF-16 路径列表 + 额外的 \0 结束符
pub fn hdrop_bytes(paths: &[String]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(DROPFILES_SIZE + paths.iter().map(|p| (p.len() + 1) * 2).sum::<usize>() + 2);
    bytes.extend_from_slice(&(DROPFILES_SIZE as u32).to_le_bytes()); // pFiles：路径列表起始偏移
    bytes.extend_from_slice(&[0u8; 12]); // pt.x、pt.y、fNC
    bytes.extend_from_slice(&1u32.to_le_bytes()); // fWide：路径为 UTF-16
    for path in paths {
        for unit in path.encode_utf16().chain(std::iter::once(0)) {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
    }
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes
}

/// 把自上而下的 RGBA 像素写成自下而上的 BGRA（CF_DIBV5 像素区，非预乘透明度保持不变）
pub fn rgba_to_bgra_bottom_up(dst: &mut [u8], rgba: &[u8], width: usize, height: usize) {
    let row = width * 4;
    for y in 0..height {
        let start = (height - 1 - y) * row;
        let out = &mut dst[start..start + row];
        out.copy_from_slice(&rgba[y * row..(y + 1) * row]);
        // 按 32 位整数交换 R、B：逐像素位运算在调试构建下同样只需几十毫秒（4K 图）
        // SAFETY：u8 与 u32 之间任意位模式都合法，align_to_mut 只取对齐的中间部分
        let (head, pixels, tail) = unsafe { out.align_to_mut::<u32>() };
        if head.is_empty() && tail.is_empty() {
            let mut i = 0;
            while i < pixels.len() {
                let p = u32::from_le(pixels[i]);
                pixels[i] = ((p & 0xFF00_FF00) | ((p & 0xFF) << 16) | ((p >> 16) & 0xFF)).to_le();
                i += 1;
            }
        } else {
            // 未对齐（实际不会出现：全局内存按 8 字节对齐、头长 124 字节）时逐字节交换
            for pixel in out.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
        }
    }
}

/// 待交给剪贴板的全局内存块：交给系统前离开作用域会自动释放
struct GlobalBlock(HGLOBAL);

impl GlobalBlock {
    /// 分配指定大小的可移动全局内存，由 `fill` 写入内容
    fn filled(size: usize, fill: impl FnOnce(&mut [u8])) -> Result<Self, String> {
        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, size) }.map_err(|e| format!("分配剪贴板内存失败：{e}"))?;
        let block = Self(handle);
        unsafe {
            let base = GlobalLock(handle) as *mut u8;
            if base.is_null() {
                return Err("锁定剪贴板内存失败".to_string());
            }
            fill(std::slice::from_raw_parts_mut(base, size));
            // 锁计数归零时返回值为「失败」但错误码为 0，属正常情况
            let _ = GlobalUnlock(handle);
        }
        Ok(block)
    }

    /// 分配全局内存并原样写入数据
    fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        Self::filled(bytes.len(), |dst| dst.copy_from_slice(bytes))
    }
}

impl Drop for GlobalBlock {
    fn drop(&mut self) {
        unsafe {
            let _ = GlobalFree(self.0);
        }
    }
}

/// 注册（或取回）自定义剪贴板格式编号
fn register_format(name: windows::core::PCWSTR) -> Result<u32, String> {
    match unsafe { RegisterClipboardFormatW(name) } {
        0 => Err("注册剪贴板格式失败".to_string()),
        id => Ok(id),
    }
}

/// 打开剪贴板 → 清空 → 依次写入 → 关闭。数据已全部备好，剪贴板只被占用极短时间。
fn write_entries(owner: HWND, entries: Vec<(u32, GlobalBlock)>) -> Result<(), String> {
    let started = std::time::Instant::now();
    let mut attempt: u64 = 0;
    loop {
        if unsafe { OpenClipboard(owner) }.is_ok() {
            break;
        }
        if started.elapsed() >= OPEN_TIMEOUT {
            return Err("剪贴板正被其他程序占用，请稍后重试".to_string());
        }
        // 先密集重试（多数占用只有几毫秒），之后逐步拉长间隔，最长 50 毫秒
        attempt += 1;
        std::thread::sleep(Duration::from_millis((attempt * 5).min(50)));
    }

    let result = (|| {
        unsafe { EmptyClipboard() }.map_err(|e| format!("清空剪贴板失败：{e}"))?;
        for (format, block) in entries {
            unsafe { SetClipboardData(format, HANDLE(block.0 .0)) }.map_err(|e| format!("写入剪贴板失败：{e}"))?;
            // 写入成功后内存归系统所有，不能再释放
            std::mem::forget(block);
        }
        Ok(())
    })();
    unsafe {
        let _ = CloseClipboard();
    }
    result
}

/// 写入图片：`rgba` 为自上而下的 RGBA 像素（非预乘），`png` 为可选的原始 PNG 字节
pub fn write_image(owner: HWND, width: u32, height: u32, rgba: &[u8], png: Option<&[u8]>) -> Result<(), String> {
    let mut entries = Vec::with_capacity(2);
    // 顺序有意义：部分程序取第一个可用格式，PNG 兼容性与透明度更好，放在前面
    if let Some(png) = png.filter(|png| !png.is_empty()) {
        entries.push((register_format(w!("PNG"))?, GlobalBlock::from_bytes(png)?));
    }
    let header = dibv5_header(width, height);
    let dib = GlobalBlock::filled(DIBV5_HEADER_SIZE + rgba.len(), |dst| {
        dst[..DIBV5_HEADER_SIZE].copy_from_slice(&header);
        rgba_to_bgra_bottom_up(&mut dst[DIBV5_HEADER_SIZE..], rgba, width as usize, height as usize);
    })?;
    entries.push((CF_DIBV5, dib));
    write_entries(owner, entries)
}

/// 写入文件列表（CF_HDROP），并声明为「复制」，在资源管理器中粘贴时不会移动原文件
pub fn write_files(owner: HWND, paths: &[String]) -> Result<(), String> {
    const DROPEFFECT_COPY: u32 = 1;
    let entries = vec![
        (CF_HDROP, GlobalBlock::from_bytes(&hdrop_bytes(paths))?),
        (register_format(w!("Preferred DropEffect"))?, GlobalBlock::from_bytes(&DROPEFFECT_COPY.to_le_bytes())?),
    ];
    write_entries(owner, entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_u32(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    #[test]
    fn dibv5_header_layout() {
        let header = dibv5_header(3, 2);
        assert_eq!(read_u32(&header, 0), 124);
        assert_eq!(read_u32(&header, 4), 3);
        // 正高度：自下而上存放
        assert_eq!(read_u32(&header, 8), 2);
        assert_eq!(u16::from_le_bytes([header[12], header[13]]), 1);
        assert_eq!(u16::from_le_bytes([header[14], header[15]]), 32);
        assert_eq!(read_u32(&header, 16), 3);
        assert_eq!(read_u32(&header, 20), 3 * 2 * 4);
        assert_eq!(read_u32(&header, 40), 0x00FF_0000);
        assert_eq!(read_u32(&header, 52), 0xFF00_0000);
        assert_eq!(read_u32(&header, 56), 0x7352_4742);
        assert_eq!(read_u32(&header, 108), 4);
    }

    #[test]
    fn rgba_rows_become_bottom_up_bgra() {
        // 2×2：第一行红、绿，第二行蓝、半透明白
        let rgba = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128];
        let mut dst = [0u8; 16];
        rgba_to_bgra_bottom_up(&mut dst, &rgba, 2, 2);
        // 自下而上：先写原第二行；BGRA：蓝色 → [255,0,0,255]，白色透明度保持 128
        assert_eq!(dst, [255, 0, 0, 255, 255, 255, 255, 128, 0, 0, 255, 255, 0, 255, 0, 255]);
    }

    #[test]
    fn hdrop_layout() {
        let bytes = hdrop_bytes(&["C:\\a.png".to_string(), "D:\\图.jpg".to_string()]);
        assert_eq!(read_u32(&bytes, 0), 20);
        assert_eq!(read_u32(&bytes, 16), 1);
        let units: Vec<u16> = bytes[20..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let text = String::from_utf16(&units).unwrap();
        // 每个路径以 \0 结尾，列表以额外的 \0 结束
        assert_eq!(text, "C:\\a.png\0D:\\图.jpg\0\0");
    }
}
