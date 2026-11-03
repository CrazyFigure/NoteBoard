//! 恢复旧 NSIS 安装器留下的文件类型覆盖；只处理有 NoteBoard 备份标记的当前用户扩展名。
use serde::Serialize;
use std::{
    collections::BTreeSet,
    fs,
    io::{self, ErrorKind, Write},
    path::Path,
};
use winreg::{enums::*, RegKey, RegValue};

// 与 NSIS 共用通知标记；安装器修复后首次启动仍需告诉用户刷新 Explorer 进程缓存。
const STATE_PATH: &str = r"Software\crazyfigure\NoteBoard\FileAssociationRepair";
const PENDING: &str = "PendingShellRefresh";
const PARTIAL: &str = "PartialRecovery";
const REVIEWED: &str = "CheckedRevision";

/// 注册表入口可注入，回归测试全部运行在隔离的 HKCU 临时键中。
struct Registry {
    user: RegKey,
    machine: RegKey,
    choices: Option<RegKey>,
    cache: Option<RegKey>,
    state_hive: RegKey,
    state_path: String,
}

impl Registry {
    /// 只读打开关联根目录；仅在确认旧覆盖、保存备份后才获取对应扩展名的写权限。
    fn open() -> io::Result<Self> {
        let user = RegKey::predef(HKEY_CURRENT_USER);
        let read = KEY_READ | KEY_WOW64_64KEY;
        Ok(Self {
            user: user.open_subkey_with_flags(r"Software\Classes", read)?,
            machine: RegKey::predef(HKEY_LOCAL_MACHINE)
                .open_subkey_with_flags(r"Software\Classes", read)?,
            choices: optional_key(
                &user,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts",
                read,
            )?,
            cache: optional_key(
                &user,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\Discardable\PostSetup\ShellNew",
                read,
            )?,
            state_hive: user,
            state_path: STATE_PATH.into(),
        })
    }

    /// 程序类型必须仍有注册，不能将“猜测的 Office 类型名”写入默认值。
    fn registered(&self, progid: &str) -> bool {
        !progid.is_empty()
            && !is_noteboard(progid)
            && [&self.user, &self.machine]
                .iter()
                .any(|root| root.open_subkey(progid).is_ok())
    }

    /// 沿用其他应用已有的新建模板，不创建或复制 ShellNew。
    fn has_shell_new(&self, extension: &str, progid: &str) -> bool {
        [&self.user, &self.machine].iter().any(|root| {
            [
                format!(r"{extension}\{progid}\ShellNew"),
                format!(r"{extension}\ShellNew"),
            ]
            .iter()
            .any(|path| {
                root.open_subkey(path).is_ok_and(|key| {
                    ["NullFile", "FileName", "Command", "Data"]
                        .iter()
                        .any(|name| key.get_raw_value(name).is_ok())
                })
            })
        })
    }

    /// 先用用户明确选过的程序，再用系统注册；没有明确选择时只接受唯一的新建模板候选。
    fn fallback(&self, extension: &str) -> io::Result<Target> {
        let office = matches!(
            extension,
            ".doc" | ".docx" | ".xls" | ".xlsx" | ".ppt" | ".pptx"
        );
        if let Some(choices) = &self.choices {
            if let Some(key) = optional_key(choices, &format!(r"{extension}\UserChoice"), KEY_READ)?
            {
                if let Some(progid) = text(&key, "ProgId")? {
                    if self.registered(&progid)
                        && (!office || self.has_shell_new(extension, &progid))
                    {
                        return Ok(Target::set(progid, "user-choice"));
                    }
                }
            }
        }
        let machine = optional_key(&self.machine, extension, KEY_READ)?
            .map(|key| text(&key, ""))
            .transpose()?
            .flatten()
            .filter(|progid| self.registered(progid));
        if let Some(progid) = &machine {
            if !office || self.has_shell_new(extension, progid) {
                return Ok(Target {
                    value: None,
                    source: "machine",
                    known: true,
                });
            }
        }
        let mut candidates = BTreeSet::new();
        for root in [&self.user, &self.machine] {
            if let Some(key) = optional_key(root, extension, KEY_READ)? {
                // 正常扩展名只有少数子键；超过上限不做不完整的唯一性判断。
                let names = key.enum_keys().take(129).collect::<io::Result<Vec<_>>>()?;
                if names.len() > 128 {
                    return Ok(Target::withdraw());
                }
                for name in names {
                    if self.registered(&name) && self.has_shell_new(extension, &name) {
                        candidates.insert(name);
                    }
                }
            }
        }
        if candidates.len() == 1 {
            return Ok(Target::set(
                candidates.into_iter().next().unwrap(),
                "shell-new",
            ));
        }
        // 无法重建已丢失的用户选择时只撤销自己的覆盖，不能随意选择 Office/WPS 中的一个。
        Ok(Target {
            value: None,
            source: "withdraw-only",
            known: machine.is_some() && !office,
        })
    }

    /// 通知标记只在实际修复后创建；普通新装和未受影响的免安装版不新增注册表项。
    fn mark_pending(&self) -> io::Result<()> {
        self.state_hive
            .create_subkey(&self.state_path)?
            .0
            .set_value(PENDING, &1u32)
    }

    /// 安装器与启动修复共用一次性提示，避免修改已经成功却因旧菜单缓存而误以为无效。
    fn pending(&self) -> bool {
        self.state_hive
            .open_subkey(&self.state_path)
            .and_then(|key| key.get_value::<u32, _>(PENDING))
            .is_ok_and(|value| value == 1)
    }

    /// 跨进程保留安装阶段的部分失败，首次启动不能将缺少原模板误报成全部恢复。
    fn mark_partial(&self) -> io::Result<()> {
        self.state_hive
            .create_subkey(&self.state_path)?
            .0
            .set_value(PARTIAL, &1u32)
    }

    /// 上一版已撤销覆盖但未刷新进程缓存时只提示一次；后续真正发生恢复仍会重新提示。
    fn reviewed(&self) -> bool {
        self.state_hive
            .open_subkey(&self.state_path)
            .and_then(|key| key.get_value::<u32, _>(REVIEWED))
            .is_ok_and(|value| value >= 1)
    }
}

/// 值类型和原始字节一并写入恢复日志，保留“未设置”与“空字符串”的区别。
#[derive(Serialize)]
struct SavedValue {
    kind: u32,
    bytes: Vec<u8>,
}
impl From<&RegValue> for SavedValue {
    fn from(value: &RegValue) -> Self {
        Self {
            kind: value.vtype.clone() as u32,
            bytes: value.bytes.clone(),
        }
    }
}

// None 表示撤销用户级覆盖，known 区分已找到系统关联和仅能撤销但无法完整还原的情况。
struct Target {
    value: Option<String>,
    source: &'static str,
    known: bool,
}
impl Target {
    fn set(value: String, source: &'static str) -> Self {
        Self {
            value: Some(value),
            source,
            known: true,
        }
    }
    fn withdraw() -> Self {
        Self {
            value: None,
            source: "withdraw-only",
            known: false,
        }
    }
}

// 快照用于落盘备份和写入前复查；不能只凭第一次扫描的结果覆盖后续变化。
struct Plan {
    extension: String,
    before: Option<RegValue>,
    backup: RegValue,
    target: Target,
}
#[derive(Serialize)]
struct JournalEntry<'a> {
    extension: &'a str,
    before: Option<SavedValue>,
    legacy_backup: SavedValue,
    restored: &'a Option<String>,
    source: &'a str,
}
#[derive(Default)]
struct Report {
    repaired: Vec<String>,
    unresolved: Vec<String>,
    errors: Vec<String>,
    needs_refresh: bool,
}

/// 非字符串备份没有可恢复的含义；读取错误保留原值，不将异常数据当成空备份。
fn text(key: &RegKey, name: &str) -> io::Result<Option<String>> {
    match key.get_value(name) {
        Ok(value) => Ok(Some(value)),
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::InvalidData) => {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

/// 只有不存在的键可以跳过，权限或 I/O 错误必须留给调用方报告。
fn optional_key(root: &RegKey, path: &str, flags: u32) -> io::Result<Option<RegKey>> {
    match root.open_subkey_with_flags(path, flags) {
        Ok(key) => Ok(Some(key)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
fn is_noteboard(value: &str) -> bool {
    value.to_ascii_lowercase().starts_with("noteboard.")
}

/// 只有 NoteBoard 备份能证明旧安装器曾覆盖该扩展名；已选择其他类型的用户必须保持原状。
fn plan(registry: &Registry, extension: &str, progid: &str) -> io::Result<Option<Plan>> {
    let Some(key) = optional_key(&registry.user, extension, KEY_READ)? else {
        return Ok(None);
    };
    let backup_name = format!("{progid}_backup");
    let Some(backup) = text(&key, &backup_name)? else {
        return Ok(None);
    };
    let before = match key.get_raw_value("") {
        Ok(value) if matches!(value.vtype, REG_SZ | REG_EXPAND_SZ) => Some(value),
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let current = text(&key, "")?;
    if current
        .as_deref()
        .is_some_and(|value| !value.is_empty() && !value.eq_ignore_ascii_case(progid))
    {
        return Ok(None);
    }
    let target = if !backup.is_empty() && !is_noteboard(&backup) {
        // 正常备份只在覆盖仍存在时恢复；不因过期备份重新创建用户已经删除的默认值。
        if !current
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case(progid))
        {
            return Ok(None);
        }
        Target::set(backup, "backup")
    } else {
        // 覆盖已被旧修复删除、但用户级 Office/WPS 的类型丢失时，也必须能继续恢复。
        registry.fallback(extension)?
    };
    Ok(Some(Plan {
        extension: extension.into(),
        before,
        backup: key.get_raw_value(backup_name)?,
        target,
    }))
}

/// 所有计划先落盘，再逐项重查并修改；不触碰机器级关联、UserChoice、名称或其他应用的模板。
fn repair(
    registry: &Registry,
    associations: &[(String, String)],
    backup_dir: &Path,
) -> io::Result<Report> {
    let mut report = Report::default();
    let mut plans = Vec::new();
    for (extension, progid) in associations {
        match plan(registry, extension, progid) {
            Ok(Some(plan)) if plan.before.is_none() && plan.target.value.is_none() => {
                // 上一版已撤销覆盖仍可能留有进程缓存；同一轮迁移只提醒一次。
                report.needs_refresh = true;
                if !plan.target.known {
                    report.unresolved.push(extension.clone());
                }
            }
            Ok(Some(plan)) => plans.push((plan, progid)),
            Ok(None) => {}
            Err(error) => report.errors.push(format!("{extension}: {error}")),
        }
    }
    if plans.is_empty() {
        finish(registry, &mut report)?;
        return Ok(report);
    }
    let journal: Vec<_> = plans
        .iter()
        .map(|(plan, _)| JournalEntry {
            extension: &plan.extension,
            before: plan.before.as_ref().map(SavedValue::from),
            legacy_backup: SavedValue::from(&plan.backup),
            restored: &plan.target.value,
            source: plan.target.source,
        })
        .collect();
    fs::create_dir_all(backup_dir)?;
    let mut file = tempfile::NamedTempFile::new_in(backup_dir)?;
    serde_json::to_writer_pretty(&mut file, &journal)?;
    file.flush()?;
    file.as_file().sync_all()?;
    file.persist(backup_dir.join(format!("file-associations-{}.json", uuid::Uuid::new_v4())))?;
    for (plan, progid) in plans {
        let apply = || -> io::Result<bool> {
            let key = registry
                .user
                .open_subkey_with_flags(&plan.extension, KEY_READ | KEY_SET_VALUE)?;
            let now = match key.get_raw_value("") {
                Ok(value) => Some(value),
                Err(error) if error.kind() == ErrorKind::NotFound => None,
                Err(error) => return Err(error),
            };
            // 备份之后若用户或其他应用已修改关联，跳过该项，不能用旧计划覆盖新选择。
            if now != plan.before || key.get_raw_value(format!("{progid}_backup"))? != plan.backup {
                return Ok(false);
            }
            registry.mark_pending()?;
            if let Some(value) = &plan.target.value {
                key.set_value("", value)?;
            } else {
                key.delete_value("")?;
            }
            Ok(true)
        };
        match apply() {
            Ok(true) => {
                report.repaired.push(plan.extension.clone());
                if !plan.target.known {
                    report.unresolved.push(plan.extension);
                }
            }
            Ok(false) => {}
            Err(error) => report.errors.push(format!("{}: {error}", plan.extension)),
        }
    }
    finish(registry, &mut report)?;
    Ok(report)
}

/// 统一完成缓存失效和一次性提示标记；旧版本已删除覆盖的状态也不能漏掉。
fn finish(registry: &Registry, report: &mut Report) -> io::Result<()> {
    let refresh = !report.repaired.is_empty() || (report.needs_refresh && !registry.reviewed());
    if refresh {
        registry.mark_pending()?;
        registry
            .state_hive
            .create_subkey(&registry.state_path)?
            .0
            .set_value(REVIEWED, &1u32)?;
        if let Some(cache) = &registry.cache {
            // 缓存写权限不能成为恢复关联的前置条件；清理失败时仍保留已完成的恢复并提示用户刷新。
            match cache.open_subkey_with_flags("", KEY_SET_VALUE) {
                Ok(cache) => {
                    for name in ["Classes", "~reserved~"] {
                        if let Err(error) = cache.delete_value(name) {
                            if error.kind() != ErrorKind::NotFound {
                                report.errors.push(error.to_string());
                            }
                        }
                    }
                }
                Err(error) => report.errors.push(error.to_string()),
            }
        }
    }
    if registry.pending() && (!report.unresolved.is_empty() || !report.errors.is_empty()) {
        registry.mark_partial()?;
    }
    Ok(())
}

/// 严格匹配内部单一参数，正常打开文档时不得误进入无界面修复流程。
pub(crate) fn is_installer_repair(mut args: impl Iterator<Item = std::ffi::OsString>) -> bool {
    args.next().as_deref() == Some(std::ffi::OsStr::new("--repair-file-associations"))
        && args.next().is_none()
}

/// 使用 Tauri 合并后的格式清单，安装器与启动恢复覆盖相同的格式，不维护第二份扩展名列表。
fn associations(config: &tauri::Config) -> Vec<(String, String)> {
    config
        .bundle
        .file_associations
        .as_deref()
        .unwrap_or_default()
        .iter()
        .flat_map(|association| {
            association.ext.iter().map(|extension| {
                (
                    format!(".{}", extension.0),
                    association
                        .name
                        .clone()
                        .unwrap_or_else(|| extension.0.clone()),
                )
            })
        })
        .collect()
}

/// 安装完成时同步恢复，退出码 0 为完成、1 为部分恢复、2 为执行失败；提示留到用户首次打开应用。
pub(crate) fn run_from_installer(config: &tauri::Config) -> i32 {
    let run = || -> io::Result<i32> {
        crate::app_dirs::init_portable()?;
        let registry = Registry::open()?;
        let report = repair(
            &registry,
            &associations(config),
            &crate::app_dirs::app_data_dir().join("repair-backups"),
        )?;
        // 即便前一版已经撤销覆盖、当前没有可写项，也要提示安装用户缺少原 Office/WPS 注册。
        if !report.unresolved.is_empty() || !report.errors.is_empty() {
            registry.mark_pending()?;
            registry.mark_partial()?;
            return Ok(1);
        }
        Ok(0)
    }();
    match run {
        Ok(code) => code,
        Err(error) => {
            log::warn!("安装后文件关联恢复失败：{error}");
            2
        }
    }
}

/// 安装版和免安装版都在后台做保守恢复；无受影响标记时只读扫描，不注册任何新文件类型。
pub(super) fn start(app: &tauri::App) {
    let associations = associations(app.config());
    let backup_dir = crate::app_dirs::app_data_dir().join("repair-backups");
    std::thread::spawn(move || {
        let result = || -> io::Result<()> {
            let registry = Registry::open()?;
            let report = repair(&registry, &associations, &backup_dir)?;
            for error in &report.errors {
                log::warn!("文件关联恢复：{error}");
            }
            if registry.pending() {
                notify(&registry, &report);
            }
            Ok(())
        }();
        if let Err(error) = result {
            log::warn!("无法恢复旧文件关联：{error}");
        }
    });
}

/// 关联变化通知不会清除已运行 Explorer 的全部进程缓存，明确提示刷新方式，禁止擅自杀进程。
fn notify(registry: &Registry, report: &Report) {
    use windows::{
        core::HSTRING,
        Win32::UI::{
            Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST},
            WindowsAndMessaging::{MessageBoxW, IDOK, MB_ICONINFORMATION, MB_OK},
        },
    };
    let mut message = "已处理 NoteBoard 旧版本遗留的 Windows 文件关联。\n\n如果右键“新建”菜单仍未恢复，请重启资源管理器，或注销后重新登录 Windows。NoteBoard 不会自动重启桌面或关闭文件夹窗口。".to_string();
    let partial = registry
        .state_hive
        .open_subkey(&registry.state_path)
        .and_then(|key| key.get_value::<u32, _>(PARTIAL))
        .is_ok_and(|value| value == 1);
    if partial || !report.unresolved.is_empty() || !report.errors.is_empty() {
        message.push_str("\n\n部分格式缺少可确认的原关联，或未能完成恢复；若刷新后仍缺少菜单，请使用 Office/WPS 自带的修复功能。未擅自新增文档模板或更改默认打开程序的用户选择。");
    }
    unsafe {
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        if MessageBoxW(
            None,
            &HSTRING::from(message),
            &HSTRING::from("NoteBoard 文件关联恢复"),
            MB_OK | MB_ICONINFORMATION,
        ) == IDOK
        {
            if let Ok(key) = registry
                .state_hive
                .open_subkey_with_flags(&registry.state_path, KEY_SET_VALUE)
            {
                let _ = key.delete_value(PENDING);
                let _ = key.delete_value(PARTIAL);
            }
        }
    }
}

#[cfg(test)]
#[path = "file_associations_tests.rs"]
mod tests;
