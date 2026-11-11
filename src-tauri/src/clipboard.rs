// NoteBoard 系统剪贴板：图片位图与文件列表
// 文本复制继续走 WebView 的 Clipboard API；图片与文件需要系统原生格式：
//   - Windows：PNG（原图为 PNG 时）+ CF_DIBV5（图片）、CF_HDROP（文件），见 clipboard/win.rs
//   - macOS：NSImage（图片）、NSURL 文件地址（文件），由 arboard 写入
//   - Linux：image/png（图片）、text/uri-list（文件），由 arboard 写入
//
// 性能：WebView2 经 IPC 传入大块二进制只有约 60 MB/s，4K 图的 RGBA 像素（33 MB）光传输就要 0.5~0.7 秒。
// 因此图片尽量以「路径」或「原始压缩字节」交给原生端解码（4K JPEG 约 30 毫秒、PNG 约 80 毫秒）：
//   1. clipboard_write_image_file：本地图片只传路径，由这里读盘解码；
//   2. clipboard_write_image + encoded：网络 / 内嵌图片传原始文件字节（通常只有几百 KB 到几 MB）；
//   3. clipboard_write_image + rgba：原生端解不了的格式（SVG、AVIF 等）由前端解码后传像素兜底。

use std::path::Path;

#[cfg(windows)]
mod win;

/// 正文编码方式与像素尺寸经请求头传递
#[cfg(desktop)]
const ENCODING_HEADER: &str = "x-nb-encoding";
#[cfg(desktop)]
const WIDTH_HEADER: &str = "x-nb-width";
#[cfg(desktop)]
const HEIGHT_HEADER: &str = "x-nb-height";

/// 解码失败的错误前缀：前端据此改为自行解码后传像素，其余错误（文件不存在、剪贴板被占用）直接提示
#[cfg(desktop)]
const DECODE_ERROR: &str = "无法解码该图片格式";

/// PNG 文件签名：原图为 PNG 时原样附带，保留透明度与原始画质
#[cfg(desktop)]
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// 解码后的图片（自上而下的非预乘 RGBA）
#[cfg(desktop)]
struct DecodedImage {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    /// 原图为 PNG 时的原始字节（Windows 额外写入 "PNG" 格式；arboard 不接受原始 PNG，其他平台不使用）
    #[cfg_attr(not(windows), allow(dead_code))]
    png: Option<Vec<u8>>,
}

/// 解码 PNG / JPEG / GIF（首帧）/ WebP / BMP / ICO，并按 EXIF 方向摆正（与页面显示一致）
#[cfg(desktop)]
fn decode_image(bytes: Vec<u8>) -> Result<DecodedImage, String> {
    use image::ImageDecoder;

    let reader = image::ImageReader::new(std::io::Cursor::new(bytes.as_slice()))
        .with_guessed_format()
        .map_err(|error| format!("{DECODE_ERROR}：{error}"))?;
    let mut decoder = reader.into_decoder().map_err(|error| format!("{DECODE_ERROR}：{error}"))?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut decoded = image::DynamicImage::from_decoder(decoder).map_err(|error| format!("{DECODE_ERROR}：{error}"))?;
    decoded.apply_orientation(orientation);
    let rgba = decoded.into_rgba8();
    let (width, height) = rgba.dimensions();
    let png = bytes.starts_with(PNG_SIGNATURE).then_some(bytes);
    Ok(DecodedImage { width, height, rgba: rgba.into_raw(), png })
}

#[cfg(all(desktop, not(windows)))]
mod native {
    use std::borrow::Cow;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// 常驻剪贴板实例：Linux 的剪贴板内容由写入进程负责应答，实例释放后其他程序就读不到
    static CLIPBOARD: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);

    /// 在常驻实例上执行一次写入，首次使用时创建
    fn with_clipboard(write: impl FnOnce(&mut arboard::Clipboard) -> Result<(), arboard::Error>) -> Result<(), String> {
        // 上次写入线程异常退出不影响后续使用，直接接管内部状态
        let mut guard = CLIPBOARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.is_none() {
            *guard = Some(arboard::Clipboard::new().map_err(describe_error)?);
        }
        let clipboard = guard.as_mut().expect("剪贴板实例已创建");
        write(clipboard).map_err(describe_error)
    }

    /// 把 arboard 错误转换为用户可读的提示
    fn describe_error(error: arboard::Error) -> String {
        match error {
            arboard::Error::ClipboardOccupied => "剪贴板正被其他程序占用，请稍后重试".to_string(),
            arboard::Error::ClipboardNotSupported => "当前系统环境不支持写入剪贴板".to_string(),
            arboard::Error::ConversionFailure => "无法转换为剪贴板格式".to_string(),
            other => format!("写入剪贴板失败：{other}"),
        }
    }

    pub fn write_image(width: usize, height: usize, rgba: Vec<u8>) -> Result<(), String> {
        with_clipboard(|clipboard| {
            clipboard.set_image(arboard::ImageData { width, height, bytes: Cow::Owned(rgba) })
        })
    }

    pub fn write_files(paths: Vec<PathBuf>) -> Result<(), String> {
        with_clipboard(|clipboard| clipboard.set().file_list(&paths))
    }

    /// 应用退出前释放实例：Linux 会把当前内容移交给剪贴板管理器，退出后仍可粘贴
    pub fn release() {
        if let Ok(mut guard) = CLIPBOARD.lock() {
            guard.take();
        }
    }
}

/// 应用退出时调用（见 lib.rs 的 RunEvent::Exit）
pub fn release() {
    #[cfg(all(desktop, not(windows)))]
    native::release();
}

/// 剪贴板所有者：发起复制的窗口（所有者为空时 Windows 会拒绝写入）。
/// 句柄以整数形式跨线程传递，进入工作线程后再还原。
#[cfg(desktop)]
#[derive(Clone, Copy)]
struct ClipboardOwner(#[cfg_attr(not(windows), allow(dead_code))] isize);

#[cfg(desktop)]
impl ClipboardOwner {
    fn of(window: &tauri::WebviewWindow) -> Result<Self, String> {
        #[cfg(windows)]
        {
            let hwnd = window.hwnd().map_err(|error| format!("无法获取窗口句柄：{error}"))?;
            Ok(Self(hwnd.0 as isize))
        }
        #[cfg(not(windows))]
        {
            let _ = window;
            Ok(Self(0))
        }
    }

    #[cfg(windows)]
    fn hwnd(self) -> windows::Win32::Foundation::HWND {
        windows::Win32::Foundation::HWND(self.0 as *mut core::ffi::c_void)
    }
}

/// 把解码后的图片写入系统剪贴板（在工作线程中调用）
#[cfg(desktop)]
fn write_decoded(owner: ClipboardOwner, image: DecodedImage) -> Result<(), String> {
    #[cfg(windows)]
    {
        win::write_image(owner.hwnd(), image.width, image.height, &image.rgba, image.png.as_deref())
    }
    #[cfg(not(windows))]
    {
        let _ = owner;
        native::write_image(image.width as usize, image.height as usize, image.rgba)
    }
}

/// 在工作线程中执行解码与写入，避免占用异步运行时
#[cfg(desktop)]
async fn run_blocking(task: impl FnOnce() -> Result<(), String> + Send + 'static) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("剪贴板任务失败：{error}"))?
}

/// 复制本地图片文件的位图：只传路径，由原生端读盘解码，不经 IPC 传输像素
#[tauri::command]
pub async fn clipboard_write_image_file(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let owner = ClipboardOwner::of(&window)?;
        return run_blocking(move || {
            let bytes = std::fs::read(&path).map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => "图片文件不存在".to_string(),
                _ => format!("读取图片失败：{error}"),
            })?;
            write_decoded(owner, decode_image(bytes)?)
        })
        .await;
    }
    #[cfg(mobile)]
    {
        let _ = (window, path);
        Err("移动端暂不支持原生复制图片".to_string())
    }
}

/// 读取请求头中的非负整数
#[cfg(desktop)]
fn header_number(request: &tauri::ipc::Request<'_>, name: &str) -> Option<usize> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
}

/// 复制图片位图：正文为原始文件字节（encoded，原生端解码）或自上而下的 RGBA 像素（rgba，需宽高请求头）
#[tauri::command]
pub async fn clipboard_write_image(window: tauri::WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    #[cfg(desktop)]
    {
        // 兼容 postMessage 回退通道传来的 JSON 数字数组
        let Some(bytes) = crate::ipc_body::body_bytes(request.body()) else {
            return Err("图片数据格式无效".to_string());
        };
        let owner = ClipboardOwner::of(&window)?;
        let encoding = request.headers().get(ENCODING_HEADER).and_then(|value| value.to_str().ok());
        if encoding == Some("encoded") {
            return run_blocking(move || write_decoded(owner, decode_image(bytes)?)).await;
        }
        if encoding != Some("rgba") {
            return Err("图片数据格式无效".to_string());
        }
        let (Some(width), Some(height)) = (header_number(&request, WIDTH_HEADER), header_number(&request, HEIGHT_HEADER)) else {
            return Err("缺少图片尺寸".to_string());
        };
        // 像素长度必须与宽高严格对应，防止越界读取
        if width == 0
            || height == 0
            || width > u32::MAX as usize
            || height > u32::MAX as usize
            || width.checked_mul(height).and_then(|count| count.checked_mul(4)) != Some(bytes.len())
        {
            return Err("图片尺寸与像素数据不一致".to_string());
        }
        let image = DecodedImage { width: width as u32, height: height as u32, rgba: bytes, png: None };
        return run_blocking(move || write_decoded(owner, image)).await;
    }
    #[cfg(mobile)]
    {
        let _ = (window, request);
        Err("移动端暂不支持原生复制图片".to_string())
    }
}

/// 把文件以「文件」形式放入系统剪贴板，可在文件管理器、聊天软件中直接粘贴
#[tauri::command]
pub async fn clipboard_write_files(window: tauri::WebviewWindow, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("没有要复制的文件".to_string());
    }
    for path in &paths {
        if !Path::new(path).exists() {
            return Err(format!("文件不存在：{path}"));
        }
    }

    #[cfg(desktop)]
    {
        let owner = ClipboardOwner::of(&window)?;
        return run_blocking(move || {
            #[cfg(windows)]
            {
                win::write_files(owner.hwnd(), &paths)
            }
            #[cfg(not(windows))]
            {
                let _ = owner;
                native::write_files(paths.into_iter().map(std::path::PathBuf::from).collect())
            }
        })
        .await;
    }
    #[cfg(mobile)]
    {
        let _ = window;
        Err("移动端请使用分享发送文件".to_string())
    }
}
