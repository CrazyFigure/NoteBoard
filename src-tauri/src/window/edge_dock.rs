//! 极窄模式自动贴边（类似 QQ 的贴边隐藏）
//!
//! - 极窄模式的标题栏拖动由本模块驱动（`begin_dock_drag` / `end_dock_drag`）：后台线程跟随光标移动窗口，
//!   开启贴边时还实时把窗口约束在桌面外沿之内。不走系统拖动循环，因而不会触发 Windows 贴靠（Aero Snap）、
//!   macOS 平铺或 Linux 边缘平铺——这些系统行为会改写窗口尺寸并记下“已贴靠”状态，
//!   退出极窄模式后再拖动时系统会把窗口还原成贴靠前的极窄尺寸。
//! - 松手后窗口贴住（或靠近）桌面外沿即吸附到该边：优先左右，其次顶部；底部通常是任务栏 / 程序坞，不吸附。
//!   两块显示器相接的边不算外沿，窗口可以正常跨屏拖动。
//! - 已吸附时鼠标离开且窗口不在前台，窗口滑出屏幕只留一条细边；鼠标碰到细边或窗口被激活时滑回。
//!
//! 每个窗口一条轮询线程（仅开启期间存在），位置动画也在该线程内逐帧完成，不占用界面线程。
//! 状态变化以 `nb://edge-dock` 事件通知前端（前端据此在吸附期间保持窗口置顶）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager, PhysicalPosition};

/// 轮询间隔：兼顾鼠标碰边的响应速度与跨线程窗口查询开销
const TICK: Duration = Duration::from_millis(40);
/// 位置 / 尺寸停止变化多久视为拖动或缩放结束
const SETTLE: Duration = Duration::from_millis(180);
/// 鼠标离开后延迟收起，避免划过窗口边缘时误收
const HIDE_DELAY: Duration = Duration::from_millis(400);
/// 距桌面外沿多近即吸附（逻辑像素）
const SNAP_DISTANCE: f64 = 16.0;
/// 收起后留在屏幕内的细边宽度（逻辑像素）
const STRIP_WIDTH: f64 = 4.0;
/// 判断鼠标是否仍在窗口内时向外放宽的距离（物理像素）
const HOVER_SLOP: f64 = 6.0;
/// 动画时长：滑出稍慢更柔和，滑回更快更跟手
const SHOW_MS: u64 = 180;
const HIDE_MS: u64 = 240;
const SNAP_MS: u64 = 160;
/// 动画帧间隔
const FRAME: Duration = Duration::from_millis(10);
/// 拖动跟随间隔（约 125 帧 / 秒）
const DRAG_FRAME: Duration = Duration::from_millis(8);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Left,
    Right,
    Top,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl Rect {
    fn from_origin(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self { left: x, top: y, right: x + width as i32, bottom: y + height as i32 }
    }

    fn contains(&self, x: f64, y: f64, slop: f64) -> bool {
        x >= self.left as f64 - slop
            && x <= self.right as f64 + slop
            && y >= self.top as f64 - slop
            && y <= self.bottom as f64 + slop
    }

    /// 点到矩形的距离平方（点在内部为 0），用于找最近的显示器
    fn distance_sq(&self, x: f64, y: f64) -> f64 {
        let dx = (self.left as f64 - x).max(0.0).max(x - self.right as f64);
        let dy = (self.top as f64 - y).max(0.0).max(y - self.bottom as f64);
        dx * dx + dy * dy
    }
}

/// 某块显示器哪些边是整个桌面的外沿（没有其他显示器与之相接）
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct DesktopEdges {
    left: bool,
    right: bool,
    top: bool,
    bottom: bool,
}

/// 一块显示器的整屏范围、工作区（去掉任务栏 / 菜单栏）与桌面外沿
#[derive(Clone, Copy, Debug)]
struct MonitorArea {
    full: Rect,
    work: Rect,
    edges: DesktopEdges,
    scale: f64,
}

/// 吸附后的布局：展开位置、收起位置与碰边感应区
#[derive(Clone, Copy, Debug)]
struct DockLayout {
    edge: Edge,
    shown: (i32, i32),
    hidden: (i32, i32),
    /// 收起后鼠标碰到此区域即滑回
    trigger: Rect,
}

#[derive(Default)]
struct DockRuntime {
    layout: Option<DockLayout>,
    hidden: bool,
}

#[derive(Default)]
struct DockShared {
    /// 每次开关递增；轮询线程与动画发现代际变化即退出
    generation: AtomicU64,
    /// 每次开始 / 结束拖动递增；拖动线程发现代际变化即退出
    drag_generation: AtomicU64,
    runtime: Mutex<DockRuntime>,
}

/// 各窗口的贴边状态（按窗口标签）
#[derive(Default)]
pub struct EdgeDockRegistry(Mutex<HashMap<String, Arc<DockShared>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DockEvent {
    label: String,
    edge: Option<Edge>,
    hidden: bool,
}

/// Linux 的 Wayland 原生会话不允许应用读取或设置窗口坐标，无法贴边
pub fn is_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
        let forced_x11 = std::env::var("GDK_BACKEND").map(|v| v.starts_with("x11")).unwrap_or(false);
        !wayland || forced_x11
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

fn shared_for(app: &tauri::AppHandle, label: &str) -> Result<Arc<DockShared>, String> {
    let registry = app.state::<EdgeDockRegistry>();
    let mut map = registry.0.lock().map_err(|e| e.to_string())?;
    Ok(map.entry(label.to_string()).or_default().clone())
}

/// 开启 / 关闭当前窗口的自动贴边；关闭时若窗口处于收起状态先平滑滑回
#[tauri::command]
pub async fn set_edge_dock(app: tauri::AppHandle, window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    if enabled && !is_supported() {
        return Err("当前桌面环境不支持自动贴边".to_string());
    }
    let shared = shared_for(&app, window.label())?;
    let generation = shared.generation.fetch_add(1, Ordering::SeqCst) + 1;
    // 开关时终止可能残留的拖动线程
    shared.drag_generation.fetch_add(1, Ordering::SeqCst);

    if enabled {
        std::thread::spawn(move || run_dock_loop(window, shared, generation));
    } else {
        tauri::async_runtime::spawn_blocking(move || reveal_and_reset(&window, &shared))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 开始拖动窗口（极窄模式下在标题栏空白处按下时调用）：窗口跟随光标直到 `end_dock_drag`；
/// `constrain` 为真（开启贴边）时不允许拖出桌面外沿
#[tauri::command]
pub fn begin_dock_drag(app: tauri::AppHandle, window: tauri::WebviewWindow, constrain: bool) -> Result<(), String> {
    let shared = shared_for(&app, window.label())?;
    let generation = shared.drag_generation.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || run_drag_loop(window, shared, generation, constrain));
    Ok(())
}

/// 结束拖动（前端松开鼠标或失去指针捕获时调用）
#[tauri::command]
pub fn end_dock_drag(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    shared_for(&app, window.label())?.drag_generation.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

/// 关闭贴边：等待在途动画感知代际变化后停下，再把收起的窗口滑回
fn reveal_and_reset(window: &tauri::WebviewWindow, shared: &DockShared) {
    std::thread::sleep(FRAME * 2);
    let (layout, hidden) = {
        let mut runtime = shared.runtime.lock().unwrap();
        let state = (runtime.layout, runtime.hidden);
        *runtime = DockRuntime::default();
        state
    };
    if let (Some(layout), true) = (layout, hidden) {
        if let Ok(pos) = window.outer_position() {
            animate(window, (pos.x, pos.y), layout.shown, SHOW_MS, || true);
        }
    }
    emit_state(window, None, false);
}

fn emit_state(window: &tauri::WebviewWindow, edge: Option<Edge>, hidden: bool) {
    let _ = window.app_handle().emit(
        "nb://edge-dock",
        DockEvent { label: window.label().to_string(), edge, hidden },
    );
}

/// 缓出曲线：起步快、收尾柔和
fn ease_out_cubic(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(3)
}

/// 在当前线程逐帧移动窗口；`alive` 返回 false 时立即停下（返回是否完整播放）
fn animate(
    window: &tauri::WebviewWindow,
    from: (i32, i32),
    to: (i32, i32),
    duration_ms: u64,
    alive: impl Fn() -> bool,
) -> bool {
    if from == to {
        return true;
    }
    let steps = (duration_ms / FRAME.as_millis() as u64).max(1);
    let start = Instant::now();
    for step in 1..=steps {
        if !alive() {
            return false;
        }
        let t = ease_out_cubic(step as f64 / steps as f64);
        let x = from.0 + ((to.0 - from.0) as f64 * t).round() as i32;
        let y = from.1 + ((to.1 - from.1) as f64 * t).round() as i32;
        let _ = window.set_position(PhysicalPosition::new(x, y));
        // 按绝对时间对齐帧，避免跨线程调用耗时累积导致动画拖长
        let next = start + FRAME * step as u32;
        if let Some(wait) = next.checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
    }
    true
}

/// 计算显示器的桌面外沿：与其他显示器相接（允许 2px 误差且有重叠区间）的边不算外沿
fn desktop_edges(current: Rect, others: &[Rect]) -> DesktopEdges {
    const TOLERANCE: i32 = 2;
    let overlaps = |a1: i32, a2: i32, b1: i32, b2: i32| a1 < b2 && b1 < a2;
    let mut edges = DesktopEdges { left: true, right: true, top: true, bottom: true };
    for other in others {
        if other == &current {
            continue;
        }
        let vertical_overlap = overlaps(current.top, current.bottom, other.top, other.bottom);
        let horizontal_overlap = overlaps(current.left, current.right, other.left, other.right);
        if vertical_overlap && (other.right - current.left).abs() <= TOLERANCE {
            edges.left = false;
        }
        if vertical_overlap && (other.left - current.right).abs() <= TOLERANCE {
            edges.right = false;
        }
        if horizontal_overlap && (other.bottom - current.top).abs() <= TOLERANCE {
            edges.top = false;
        }
        if horizontal_overlap && (other.top - current.bottom).abs() <= TOLERANCE {
            edges.bottom = false;
        }
    }
    edges
}

/// 把越出桌面外沿的窗口推回工作区；先推右 / 下再推左 / 上，窗口比工作区还大时保证标题栏与左侧内容可见
fn clamp_into_work(x: i32, y: i32, width: i32, height: i32, work: Rect, edges: DesktopEdges) -> (i32, i32) {
    let (mut x, mut y) = (x, y);
    if edges.right && x + width > work.right {
        x = work.right - width;
    }
    if edges.left && x < work.left {
        x = work.left;
    }
    if edges.bottom && y + height > work.bottom {
        y = work.bottom - height;
    }
    if edges.top && y < work.top {
        y = work.top;
    }
    (x, y)
}

/// 拖动结束后的落点：先推回桌面内，再判断是否吸附（左右优先于顶部，底部不吸附）
fn resolve_settle(window: Rect, area: &MonitorArea) -> ((i32, i32), Option<DockLayout>) {
    let MonitorArea { work, edges, scale, .. } = *area;
    let width = window.right - window.left;
    let height = window.bottom - window.top;
    let snap = (SNAP_DISTANCE * scale).round() as i32;
    let strip = (STRIP_WIDTH * scale).round().max(2.0) as i32;
    let (mut x, mut y) = clamp_into_work(window.left, window.top, width, height, work, edges);

    let edge = if edges.left && x <= work.left + snap {
        Edge::Left
    } else if edges.right && x + width >= work.right - snap {
        Edge::Right
    } else if edges.top && y <= work.top + snap {
        Edge::Top
    } else {
        return ((x, y), None);
    };
    match edge {
        Edge::Left => x = work.left,
        Edge::Right => x = work.right - width,
        Edge::Top => y = work.top,
    }
    let (hidden, trigger) = match edge {
        Edge::Left => (
            (work.left - width + strip, y),
            Rect { left: work.left - 2, top: y, right: work.left + strip, bottom: y + height },
        ),
        Edge::Right => (
            (work.right - strip, y),
            Rect { left: work.right - strip, top: y, right: work.right + 2, bottom: y + height },
        ),
        Edge::Top => (
            (x, work.top - height + strip),
            Rect { left: x, top: work.top - 2, right: x + width, bottom: work.top + strip },
        ),
    };
    ((x, y), Some(DockLayout { edge, shown: (x, y), hidden, trigger }))
}

/// 读取全部显示器的整屏、工作区与桌面外沿
fn monitor_areas(window: &tauri::WebviewWindow) -> Vec<MonitorArea> {
    let monitors = window.available_monitors().unwrap_or_default();
    let fulls: Vec<Rect> = monitors
        .iter()
        .map(|m| Rect::from_origin(m.position().x, m.position().y, m.size().width, m.size().height))
        .collect();
    monitors
        .iter()
        .zip(&fulls)
        .map(|(monitor, &full)| {
            let work_area = monitor.work_area();
            MonitorArea {
                full,
                work: Rect::from_origin(work_area.position.x, work_area.position.y, work_area.size.width, work_area.size.height),
                edges: desktop_edges(full, &fulls),
                scale: monitor.scale_factor(),
            }
        })
        .collect()
}

/// 点所在（或最近）的显示器
fn area_at(areas: &[MonitorArea], x: f64, y: f64) -> Option<&MonitorArea> {
    areas.iter().min_by(|a, b| a.full.distance_sq(x, y).total_cmp(&b.full.distance_sq(x, y)))
}

/// Windows 主键是否仍按着（兜底：前端未收到松开事件时拖动线程也能结束；左右键互换时取右键）
#[cfg(target_os = "windows")]
fn primary_button_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
    unsafe {
        let key = if GetSystemMetrics(SM_SWAPBUTTON) != 0 { VK_RBUTTON } else { VK_LBUTTON };
        (GetAsyncKeyState(key.0 as i32) as u16 & 0x8000) != 0
    }
}

/// 拖动线程：保持按下时光标与窗口左上角的偏移，逐帧跟随光标；需要时约束在光标所在显示器的桌面外沿内
fn run_drag_loop(window: tauri::WebviewWindow, shared: Arc<DockShared>, generation: u64, constrain: bool) {
    let alive = || shared.drag_generation.load(Ordering::SeqCst) == generation;
    let app = window.app_handle().clone();
    let (Ok(cursor), Ok(pos), Ok(size)) = (app.cursor_position(), window.outer_position(), window.outer_size()) else {
        return;
    };
    let offset = (cursor.x - pos.x as f64, cursor.y - pos.y as f64);
    let (width, height) = (size.width as i32, size.height as i32);
    let areas = if constrain { monitor_areas(&window) } else { Vec::new() };
    let mut last = (pos.x, pos.y);

    while alive() {
        #[cfg(target_os = "windows")]
        if !primary_button_down() {
            break;
        }
        let Ok(cursor) = app.cursor_position() else {
            break;
        };
        let x = (cursor.x - offset.0).round() as i32;
        let y = (cursor.y - offset.1).round() as i32;
        let target = match area_at(&areas, cursor.x, cursor.y) {
            Some(area) => clamp_into_work(x, y, width, height, area.work, area.edges),
            None => (x, y),
        };
        if target != last {
            if window.set_position(PhysicalPosition::new(target.0, target.1)).is_err() {
                break;
            }
            last = target;
        }
        std::thread::sleep(DRAG_FRAME);
    }
}

fn run_dock_loop(window: tauri::WebviewWindow, shared: Arc<DockShared>, generation: u64) {
    let alive = || shared.generation.load(Ordering::SeqCst) == generation;
    let mut last_rect: Option<Rect> = None;
    let mut last_change = Instant::now().checked_sub(SETTLE * 2).unwrap_or_else(Instant::now);
    let mut needs_settle = true;
    let mut outside_since: Option<Instant> = None;

    while alive() {
        std::thread::sleep(TICK);
        if !alive() {
            break;
        }
        // 窗口已销毁时查询失败，线程随之结束
        let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
            break;
        };
        let rect = Rect::from_origin(pos.x, pos.y, size.width, size.height);
        let now = Instant::now();

        // 用户拖动或缩放：取消吸附，等停稳后重新判断落点
        if last_rect.is_some_and(|last| last != rect) {
            last_change = now;
            needs_settle = true;
            outside_since = None;
            let mut runtime = shared.runtime.lock().unwrap();
            if runtime.layout.is_some() && !runtime.hidden {
                runtime.layout = None;
                drop(runtime);
                emit_state(&window, None, false);
            }
        }
        last_rect = Some(rect);
        if now.duration_since(last_change) < SETTLE {
            continue;
        }

        if needs_settle {
            needs_settle = false;
            // 被系统最大化（如快捷键）时先恢复普通窗口，下一轮按新尺寸重新判断
            if window.is_maximized().unwrap_or(false) {
                let _ = window.unmaximize();
                needs_settle = true;
                continue;
            }
            let center = ((rect.left + rect.right) as f64 / 2.0, (rect.top + rect.bottom) as f64 / 2.0);
            let areas = monitor_areas(&window);
            let Some(area) = area_at(&areas, center.0, center.1) else {
                continue;
            };
            let (target, layout) = resolve_settle(rect, area);
            if target != (rect.left, rect.top) && animate(&window, (rect.left, rect.top), target, SNAP_MS, alive) {
                last_rect = Some(Rect::from_origin(target.0, target.1, size.width, size.height));
            }
            shared.runtime.lock().unwrap().layout = layout;
            emit_state(&window, layout.map(|l| l.edge), false);
            continue;
        }

        let (layout, hidden) = {
            let runtime = shared.runtime.lock().unwrap();
            (runtime.layout, runtime.hidden)
        };
        let Some(layout) = layout else {
            continue;
        };
        let Ok(cursor) = window.app_handle().cursor_position() else {
            continue;
        };
        let focused = window.is_focused().unwrap_or(false);

        if hidden {
            // 鼠标碰到细边，或窗口被任务栏 / 快捷键激活时滑回
            if focused || layout.trigger.contains(cursor.x, cursor.y, 0.0) {
                if animate(&window, (rect.left, rect.top), layout.shown, SHOW_MS, alive) {
                    let (x, y) = layout.shown;
                    last_rect = Some(Rect::from_origin(x, y, size.width, size.height));
                    shared.runtime.lock().unwrap().hidden = false;
                    emit_state(&window, Some(layout.edge), false);
                }
            }
            continue;
        }

        // 正在使用（前台）或鼠标仍在窗口上时保持展开
        if focused || rect.contains(cursor.x, cursor.y, HOVER_SLOP) {
            outside_since = None;
            continue;
        }
        let since = *outside_since.get_or_insert(now);
        if now.duration_since(since) < HIDE_DELAY {
            continue;
        }
        outside_since = None;
        if animate(&window, (rect.left, rect.top), layout.hidden, HIDE_MS, alive) {
            let (x, y) = layout.hidden;
            last_rect = Some(Rect::from_origin(x, y, size.width, size.height));
            shared.runtime.lock().unwrap().hidden = true;
            emit_state(&window, Some(layout.edge), true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: Rect = Rect { left: 0, top: 0, right: 1920, bottom: 1080 };
    const WORK: Rect = Rect { left: 0, top: 0, right: 1920, bottom: 1040 };
    const ALL_EDGES: DesktopEdges = DesktopEdges { left: true, right: true, top: true, bottom: true };

    fn area(edges: DesktopEdges, scale: f64) -> MonitorArea {
        MonitorArea { full: FULL, work: WORK, edges, scale }
    }

    #[test]
    fn 靠近左边吸附并计算收起位置() {
        let window = Rect::from_origin(10, 200, 408, 600);
        let (target, layout) = resolve_settle(window, &area(ALL_EDGES, 1.0));
        let layout = layout.expect("应吸附");
        assert_eq!(layout.edge, Edge::Left);
        assert_eq!(target, (0, 200));
        assert_eq!(layout.hidden, (-404, 200));
    }

    #[test]
    fn 左右优先于顶部() {
        // 同时贴住右边和上边：取右边
        let window = Rect::from_origin(1920 - 408, 0, 408, 600);
        let (_, layout) = resolve_settle(window, &area(ALL_EDGES, 1.0));
        assert_eq!(layout.unwrap().edge, Edge::Right);
    }

    #[test]
    fn 顶部吸附后向上收起() {
        let window = Rect::from_origin(600, 8, 408, 600);
        let (target, layout) = resolve_settle(window, &area(ALL_EDGES, 1.0));
        let layout = layout.expect("应吸附顶部");
        assert_eq!(layout.edge, Edge::Top);
        assert_eq!(target, (600, 0));
        assert_eq!(layout.hidden, (600, -596));
    }

    #[test]
    fn 底部只推回不吸附() {
        let window = Rect::from_origin(600, 600, 408, 600);
        let (target, layout) = resolve_settle(window, &area(ALL_EDGES, 1.0));
        assert_eq!(target, (600, 1040 - 600));
        assert!(layout.is_none());
    }

    #[test]
    fn 越出桌面时推回并吸附() {
        let window = Rect::from_origin(1700, 900, 408, 600);
        let (target, layout) = resolve_settle(window, &area(ALL_EDGES, 1.0));
        assert_eq!(target, (1920 - 408, 1040 - 600));
        assert_eq!(layout.unwrap().edge, Edge::Right);
    }

    #[test]
    fn 远离边缘不吸附() {
        let window = Rect::from_origin(600, 300, 408, 600);
        let (target, layout) = resolve_settle(window, &area(ALL_EDGES, 1.0));
        assert_eq!(target, (600, 300));
        assert!(layout.is_none());
    }

    #[test]
    fn 相邻显示器之间的边不是外沿() {
        let left = Rect { left: 0, top: 0, right: 1920, bottom: 1080 };
        let right = Rect { left: 1920, top: 0, right: 3840, bottom: 1080 };
        let edges = desktop_edges(left, &[left, right]);
        assert_eq!(edges, DesktopEdges { left: true, right: false, top: true, bottom: true });
        // 右边不是外沿：靠近也不吸附，拖动时也不阻挡，可继续拖向右侧显示器
        let window = Rect::from_origin(1920 - 300, 300, 408, 600);
        let (target, layout) = resolve_settle(window, &area(edges, 1.0));
        assert_eq!(target, (1920 - 300, 300));
        assert!(layout.is_none());
    }

    #[test]
    fn 高缩放下按逻辑像素计算吸附距离与细边() {
        let window = Rect::from_origin(30, 200, 816, 600);
        let (_, layout) = resolve_settle(window, &area(ALL_EDGES, 2.0));
        let layout = layout.expect("32 物理像素内应吸附");
        assert_eq!(layout.hidden, (-816 + 8, 200));
    }

    #[test]
    fn 窗口比工作区高时保留标题栏可见() {
        let (x, y) = clamp_into_work(600, 300, 408, 1200, WORK, ALL_EDGES);
        assert_eq!((x, y), (600, 0));
    }

    #[test]
    fn 拖动时取光标所在或最近的显示器() {
        let first = area(ALL_EDGES, 1.0);
        let second = MonitorArea { full: Rect { left: 1920, top: 0, right: 3840, bottom: 1080 }, ..first };
        let areas = [first, second];
        assert_eq!(area_at(&areas, 2500.0, 500.0).unwrap().full.left, 1920);
        // 光标落在两块屏幕之外（如移出屏幕下方）时取最近的一块
        assert_eq!(area_at(&areas, 100.0, 1200.0).unwrap().full.left, 0);
    }
}
