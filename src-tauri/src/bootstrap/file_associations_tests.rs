//! 原生注册表回归：每例只读写随机 HKCU 沙箱，不修改本机真实关联，也不弹出提示。
use super::*;

struct Sandbox {
    registry: Registry,
    directory: tempfile::TempDir,
    path: String,
}
impl Sandbox {
    fn new() -> Self {
        let path = format!(
            r"Software\crazyfigure\NoteBoard\AssociationTests\{}",
            uuid::Uuid::new_v4()
        );
        let root = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(&path)
            .unwrap()
            .0;
        let registry = Registry {
            user: root.create_subkey("user").unwrap().0,
            machine: root.create_subkey("machine").unwrap().0,
            choices: Some(root.create_subkey("choices").unwrap().0),
            cache: Some(root.create_subkey("cache").unwrap().0),
            state_hive: root,
            state_path: "state".into(),
        };
        Self {
            registry,
            directory: tempfile::tempdir().unwrap(),
            path,
        }
    }

    /// 只模拟旧安装器实际写过的标记；是否保留默认值用于区分旧覆盖和上一版修复后的状态。
    fn legacy(&self, extension: &str, before: Option<&str>, backup: &str) -> RegKey {
        let key = self.registry.user.create_subkey(extension).unwrap().0;
        if let Some(value) = before {
            key.set_value("", &value).unwrap();
        }
        key.set_value("NoteBoard.DocumentPreview_backup", &backup)
            .unwrap();
        key
    }

    /// Office/WPS 只在当前用户下注册，系统层无默认值，正是原修复删除覆盖后仍缺菜单的情况。
    fn office(&self, extension: &str, progid: &str, machine: bool) {
        let root = if machine {
            &self.registry.machine
        } else {
            &self.registry.user
        };
        root.create_subkey(progid)
            .unwrap()
            .0
            .set_value("", &"原应用文档类型")
            .unwrap();
        root.create_subkey(format!(r"{extension}\{progid}\ShellNew"))
            .unwrap()
            .0
            .set_value("FileName", &"original-template")
            .unwrap();
    }

    fn choice(&self, extension: &str, progid: &str) {
        self.registry
            .choices
            .as_ref()
            .unwrap()
            .create_subkey(format!(r"{extension}\UserChoice"))
            .unwrap()
            .0
            .set_value("ProgId", &progid)
            .unwrap();
    }

    fn repair(&self, extension: &str) -> Report {
        repair(
            &self.registry,
            &[(extension.into(), "NoteBoard.DocumentPreview".into())],
            self.directory.path(),
        )
        .unwrap()
    }

    fn default(&self, extension: &str) -> Option<String> {
        text(&self.registry.user.open_subkey(extension).unwrap(), "").unwrap()
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        // 删除范围严格限定为本例创建的随机注册表键；所有文件由 TempDir 清理。
        let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.path);
    }
}

#[test]
fn intact_backup_is_restored_and_journaled_once() {
    let sandbox = Sandbox::new();
    let key = sandbox.legacy(".docx", Some("NoteBoard.DocumentPreview"), "WPS.Docx.6");
    sandbox.office(".docx", "WPS.Docx.6", false);
    key.set_value("Content Type", &"original/type").unwrap();
    let report = sandbox.repair(".docx");
    assert_eq!(report.repaired, [".docx"]);
    assert_eq!(sandbox.default(".docx").as_deref(), Some("WPS.Docx.6"));
    assert!(sandbox.registry.pending());
    assert_eq!(
        key.get_value::<String, _>("Content Type").unwrap(),
        "original/type"
    );
    let files = fs::read_dir(sandbox.directory.path())
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(files.len(), 1);
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(files[0].path()).unwrap()).unwrap();
    assert_eq!(journal[0]["source"], "backup");
    assert!(journal[0]["before"]["bytes"]
        .as_array()
        .is_some_and(|bytes| !bytes.is_empty()));
    assert!(sandbox.repair(".docx").repaired.is_empty());
    assert_eq!(fs::read_dir(sandbox.directory.path()).unwrap().count(), 1);
}

#[test]
fn lost_backup_recovers_user_only_office_for_all_six_extensions() {
    for (extension, progid) in [
        (".doc", "WPS.Doc.6"),
        (".docx", "WPS.Docx.6"),
        (".xls", "ET.Xls.6"),
        (".xlsx", "ET.Xlsx.6"),
        (".ppt", "WPP.PPT.6"),
        (".pptx", "WPP.PPTX.6"),
    ] {
        let sandbox = Sandbox::new();
        sandbox.legacy(
            extension,
            Some("NoteBoard.DocumentPreview"),
            "NoteBoard.DocumentPreview",
        );
        sandbox.office(extension, progid, false);
        sandbox.choice(extension, progid);
        let report = sandbox.repair(extension);
        assert_eq!(report.repaired, [extension]);
        assert!(report.unresolved.is_empty());
        assert_eq!(sandbox.default(extension).as_deref(), Some(progid));
        assert_eq!(
            sandbox
                .registry
                .choices
                .as_ref()
                .unwrap()
                .open_subkey(format!(r"{extension}\UserChoice"))
                .unwrap()
                .get_value::<String, _>("ProgId")
                .unwrap(),
            progid
        );
        assert_eq!(
            sandbox
                .registry
                .user
                .open_subkey(format!(r"{extension}\{progid}\ShellNew"))
                .unwrap()
                .get_value::<String, _>("FileName")
                .unwrap(),
            "original-template"
        );
    }
}

#[test]
fn previous_installer_removed_override_can_still_recover_user_only_template() {
    for backup in ["", "NoteBoard.DocumentPreview"] {
        let sandbox = Sandbox::new();
        sandbox.legacy(".docx", None, backup);
        sandbox.office(".docx", "WPS.Docx.6", false);
        // 无 UserChoice，但注册的模板只有一个，同样可以恢复，不硬编码 WPS 类型名。
        assert_eq!(sandbox.repair(".docx").repaired, [".docx"]);
        assert_eq!(sandbox.default(".docx").as_deref(), Some("WPS.Docx.6"));
    }
}

#[test]
fn machine_association_is_inherited_without_writing_machine_registry() {
    let sandbox = Sandbox::new();
    sandbox.legacy(".docx", Some("NoteBoard.DocumentPreview"), "");
    sandbox.office(".docx", "Word.Document.12", true);
    let machine = sandbox.registry.machine.create_subkey(".docx").unwrap().0;
    machine.set_value("", &"Word.Document.12").unwrap();
    let report = sandbox.repair(".docx");
    assert_eq!(report.repaired, [".docx"]);
    assert!(report.unresolved.is_empty());
    assert!(sandbox.default(".docx").is_none());
    assert_eq!(
        machine.get_value::<String, _>("").unwrap(),
        "Word.Document.12"
    );
}

#[test]
fn explicit_user_choice_wins_when_multiple_office_templates_exist() {
    let sandbox = Sandbox::new();
    sandbox.legacy(
        ".docx",
        Some("NoteBoard.DocumentPreview"),
        "NoteBoard.DocumentPreview",
    );
    sandbox.office(".docx", "WPS.Docx.6", false);
    sandbox.office(".docx", "Word.Document.12", true);
    sandbox
        .registry
        .machine
        .create_subkey(".docx")
        .unwrap()
        .0
        .set_value("", &"Word.Document.12")
        .unwrap();
    sandbox.choice(".docx", "WPS.Docx.6");
    sandbox.repair(".docx");
    assert_eq!(sandbox.default(".docx").as_deref(), Some("WPS.Docx.6"));
}

#[test]
fn ambiguous_templates_do_not_guess_and_report_incomplete_recovery() {
    let sandbox = Sandbox::new();
    sandbox.legacy(
        ".docx",
        Some("NoteBoard.DocumentPreview"),
        "NoteBoard.DocumentPreview",
    );
    sandbox.office(".docx", "WPS.Docx.6", false);
    sandbox.office(".docx", "Word.Document.12", true);
    let report = sandbox.repair(".docx");
    assert!(sandbox.default(".docx").is_none());
    assert_eq!(report.unresolved, [".docx"]);
}

#[test]
fn changed_default_and_missing_default_with_intact_backup_are_preserved() {
    for current in [Some("Other.App"), None, Some("")] {
        let sandbox = Sandbox::new();
        sandbox.legacy(".docx", current, "WPS.Docx.6");
        sandbox.office(".docx", "WPS.Docx.6", false);
        assert!(sandbox.repair(".docx").repaired.is_empty());
        assert_eq!(sandbox.default(".docx").as_deref(), current);
        assert!(!sandbox.registry.pending());
        assert_eq!(fs::read_dir(sandbox.directory.path()).unwrap().count(), 0);
    }
}

#[test]
fn no_backup_or_invalid_backup_never_changes_an_association() {
    for backup_kind in [None, Some(7u32)] {
        let sandbox = Sandbox::new();
        let key = sandbox.registry.user.create_subkey(".docx").unwrap().0;
        key.set_value("", &"NoteBoard.DocumentPreview").unwrap();
        if let Some(value) = backup_kind {
            key.set_value("NoteBoard.DocumentPreview_backup", &value)
                .unwrap();
        }
        sandbox.office(".docx", "WPS.Docx.6", false);
        assert!(sandbox.repair(".docx").repaired.is_empty());
        assert_eq!(
            sandbox.default(".docx").as_deref(),
            Some("NoteBoard.DocumentPreview")
        );
        assert!(!sandbox.registry.pending());
    }
}

#[test]
fn journal_failure_prevents_registry_writes() {
    let sandbox = Sandbox::new();
    sandbox.legacy(".docx", Some("NoteBoard.DocumentPreview"), "WPS.Docx.6");
    let blocked = sandbox.directory.path().join("file");
    fs::write(&blocked, b"occupied").unwrap();
    assert!(repair(
        &sandbox.registry,
        &[(".docx".into(), "NoteBoard.DocumentPreview".into())],
        &blocked
    )
    .is_err());
    assert_eq!(
        sandbox.default(".docx").as_deref(),
        Some("NoteBoard.DocumentPreview")
    );
    assert!(!sandbox.registry.pending());
}

#[test]
fn successful_repair_invalidates_only_discardable_cache_and_ignores_stale_choices() {
    let sandbox = Sandbox::new();
    sandbox.legacy(
        ".docx",
        Some("NoteBoard.DocumentPreview"),
        "NoteBoard.DocumentPreview",
    );
    sandbox.office(".docx", "WPS.Docx.6", false);
    sandbox.choice(".docx", "Uninstalled.App");
    let cache = sandbox.registry.cache.as_ref().unwrap();
    cache.set_value("Classes", &"old-list").unwrap();
    cache.set_value("~reserved~", &"old-time").unwrap();
    cache.set_value("other-value", &"keep").unwrap();
    sandbox.repair(".docx");
    assert_eq!(sandbox.default(".docx").as_deref(), Some("WPS.Docx.6"));
    assert!(cache.get_raw_value("Classes").is_err());
    assert!(cache.get_raw_value("~reserved~").is_err());
    assert_eq!(cache.get_value::<String, _>("other-value").unwrap(), "keep");
}

#[test]
fn installer_mode_requires_the_exact_standalone_internal_argument() {
    let matches = |args: &[&str]| is_installer_repair(args.iter().map(std::ffi::OsString::from));
    assert!(matches(&["--repair-file-associations"]));
    assert!(!matches(&[]));
    assert!(!matches(&["--repair-file-associations", "note.md"]));
    assert!(!matches(&["note.md", "--repair-file-associations"]));
    assert!(!matches(&["--repair-file-associations-other"]));
}

#[test]
fn clean_installation_does_not_register_types_write_metadata_or_create_journals() {
    let sandbox = Sandbox::new();
    assert!(sandbox.repair(".docx").repaired.is_empty());
    assert!(sandbox.registry.user.open_subkey(".docx").is_err());
    assert!(sandbox.registry.state_hive.open_subkey("state").is_err());
    assert_eq!(fs::read_dir(sandbox.directory.path()).unwrap().count(), 0);
}

#[test]
fn previous_partial_repair_reports_unresolved_without_repeated_writes() {
    let sandbox = Sandbox::new();
    sandbox.legacy(".docx", None, "NoteBoard.DocumentPreview");
    let report = sandbox.repair(".docx");
    assert!(report.repaired.is_empty());
    assert_eq!(report.unresolved, [".docx"]);
    assert!(sandbox.registry.pending());
    let state = sandbox
        .registry
        .state_hive
        .open_subkey_with_flags("state", KEY_SET_VALUE)
        .unwrap();
    state.delete_value(PENDING).unwrap();
    let next = sandbox.repair(".docx");
    assert!(next.repaired.is_empty());
    assert!(!sandbox.registry.pending());
    assert_eq!(fs::read_dir(sandbox.directory.path()).unwrap().count(), 0);
}

#[test]
fn previous_fix_inheriting_machine_type_gets_a_single_cache_refresh_notice() {
    let sandbox = Sandbox::new();
    sandbox.legacy(".docx", None, "NoteBoard.DocumentPreview");
    sandbox.office(".docx", "Word.Document.12", true);
    sandbox
        .registry
        .machine
        .create_subkey(".docx")
        .unwrap()
        .0
        .set_value("", &"Word.Document.12")
        .unwrap();
    let cache = sandbox.registry.cache.as_ref().unwrap();
    cache.set_value("Classes", &"old-list").unwrap();
    assert!(sandbox.repair(".docx").repaired.is_empty());
    assert!(sandbox.registry.pending());
    assert!(cache.get_raw_value("Classes").is_err());
    sandbox
        .registry
        .state_hive
        .open_subkey_with_flags("state", KEY_SET_VALUE)
        .unwrap()
        .delete_value(PENDING)
        .unwrap();
    sandbox.repair(".docx");
    assert!(!sandbox.registry.pending());
    assert!(sandbox.default(".docx").is_none());
}
