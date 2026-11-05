// 本地文件搜索端到端测试：真实目录 → 后台引擎建索引 → 文件名 / 内容查询 → 增量更新 → 快照重载

use super::engine::{Engine, Handle, Msg};
use super::query::{search_content, search_content_in, search_names, search_names_in, ContentResult, NameResult};
use super::text::Query;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// 等待引擎连续两次报告空闲（扫描、内容任务、文件变化均处理完）
fn wait_idle(h: &Handle) {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut streak = 0;
    while Instant::now() < deadline {
        let (tx, rx) = crossbeam_channel::bounded(1);
        h.send(Msg::Probe(tx));
        if rx.recv_timeout(Duration::from_secs(10)).unwrap_or(false) {
            streak += 1;
            if streak >= 2 {
                return;
            }
        } else {
            streak = 0;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    panic!("引擎未在预期时间内空闲");
}

fn names(h: &Handle, q: &str) -> NameResult {
    let index = h.shared.index.read().unwrap();
    search_names(&index, &Query::parse(q), 50, &|| false).unwrap()
}

fn contents(h: &Handle, q: &str) -> ContentResult {
    search_content(&h.shared.index, &Query::parse(q), 50, &|| false).unwrap()
}

fn hit_names(r: &NameResult) -> Vec<String> {
    r.hits.iter().map(|h| h.name.clone()).collect()
}

fn content_names(r: &ContentResult) -> Vec<String> {
    r.hits.iter().map(|h| h.name.clone()).collect()
}

fn write_docx(path: &Path, text: &str) {
    let file = fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("word/document.xml", zip::write::SimpleFileOptions::default()).unwrap();
    write!(zip, "<w:document><w:body><w:p><w:r><w:t>{}</w:t></w:r></w:p></w:body></w:document>", text).unwrap();
    zip.finish().unwrap();
}

/// 构造测试目录：中文笔记、英文文本、Office 文档、二进制、被排除的依赖目录
fn sample_tree(root: &Path) {
    fs::create_dir_all(root.join("项目/会议")).unwrap();
    fs::create_dir_all(root.join("项目/node_modules/pkg")).unwrap();
    fs::write(root.join("项目/会议/会议纪要.md"), "# 周会\n\n本周讨论本地文件搜索方案。\n结论：采用倒排索引，首次建立索引在后台完成。\n").unwrap();
    fs::write(root.join("todo.txt"), "Buy milk\r\nCall Alice about NoteBoard\r\n").unwrap();
    fs::write(root.join("项目/node_modules/pkg/index.js"), "const secretToken = 1;").unwrap();
    fs::create_dir_all(root.join(".toolcache/deep")).unwrap();
    fs::write(root.join(".toolcache/deep/cached.md"), "hiddenToolData").unwrap();
    // 软件安装目录：含动态库，子目录中的文本只收录文件名
    fs::create_dir_all(root.join("某软件/docs")).unwrap();
    fs::write(root.join("某软件/core.dll"), [0u8, 1, 2]).unwrap();
    fs::write(root.join("某软件/docs/manual.txt"), "programManualText").unwrap();
    // 下载目录中的单个安装包不影响其他文档
    fs::create_dir_all(root.join("下载")).unwrap();
    fs::write(root.join("下载/setup.exe"), [0u8, 1]).unwrap();
    fs::write(root.join("下载/合同.txt"), "downloadedContract").unwrap();
    // 根目录散落的动态库不影响整个位置
    fs::write(root.join("stray.dll"), [0u8, 1]).unwrap();
    fs::write(root.join("项目/图片.png"), [0x89, b'P', b'N', b'G', 0, 0, 0, 1]).unwrap();
    write_docx(&root.join("项目/季度报告.docx"), "第三季度营收增长显著");
}

fn start(root: &Path, snapshot: Option<PathBuf>) -> Handle {
    let h = Engine::spawn(snapshot, Box::new(|| {}), false);
    h.send(Msg::Configure { enabled: true, roots: vec![root.to_string_lossy().to_string()], delay: Duration::ZERO });
    wait_idle(&h);
    h
}

/// 网页端按权限限定范围：只返回范围内的结果，计数不含范围外；范围内的隐藏项同样不返回
#[test]
fn scoped_queries_only_return_entries_inside_allowed_locations() {
    let dir = tempfile::tempdir().unwrap();
    let alice = dir.path().join("alice");
    let bob = dir.path().join("bob");
    fs::create_dir_all(alice.join("共享")).unwrap();
    fs::create_dir_all(bob.join("私人")).unwrap();
    fs::write(alice.join("共享/计划.md"), "scopeSecretWord alice shared").unwrap();
    fs::write(alice.join("日记.md"), "scopeSecretWord alice private").unwrap();
    fs::write(alice.join(".草稿.md"), "scopeSecretWord alice hidden").unwrap();
    fs::write(bob.join("私人/计划.md"), "scopeSecretWord bob private").unwrap();
    let h = Engine::spawn(None, Box::new(|| {}), false);
    let roots = [&alice, &bob].map(|p| p.to_string_lossy().to_string()).to_vec();
    h.send(Msg::Configure { enabled: true, roots, delay: Duration::ZERO });
    wait_idle(&h);
    let canonical = |p: &Path| dunce::canonicalize(p).unwrap();

    // bob 可访问：自己的工作区 + alice 共享的文件夹
    let scope = vec![canonical(&bob), canonical(&alice.join("共享"))];
    let index = h.shared.index.read().unwrap();
    let named = search_names_in(&index, &Query::parse("计划"), 50, Some(&scope), &|| false).unwrap();
    assert_eq!(named.total, 2);
    let mut paths: Vec<String> = named.hits.iter().map(|h| h.path.clone()).collect();
    paths.sort();
    assert!(paths.iter().all(|p| p.contains("bob") || p.contains("共享")), "{paths:?}");
    drop(index);
    let found = search_content_in(&h.shared.index, &Query::parse("scopeSecretWord"), 50, Some(&scope), &|| false).unwrap();
    let mut texts: Vec<String> = found.hits.iter().map(|h| h.path.clone()).collect();
    texts.sort();
    assert_eq!(texts.len(), 2, "{texts:?}");
    assert!(!texts.iter().any(|p| p.contains("日记") || p.contains(".草稿")));

    // alice 访问自己的工作区：隐藏文件不返回
    let own = vec![canonical(&alice)];
    let found = search_content_in(&h.shared.index, &Query::parse("scopeSecretWord"), 50, Some(&own), &|| false).unwrap();
    assert_eq!(found.hits.len(), 2);
    assert!(!found.hits.iter().any(|h| h.name.starts_with('.')));
    // 范围内没有已索引的位置时直接返回空
    let none = vec![dir.path().join("不存在")];
    let index = h.shared.index.read().unwrap();
    assert!(search_names_in(&index, &Query::parse("计划"), 50, Some(&none), &|| false).unwrap().hits.is_empty());
    h.send(Msg::Shutdown);
}

#[test]
fn builds_index_and_answers_name_and_content_queries() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("notes");
    sample_tree(&root);
    let h = start(&root, None);

    // 文件名：中文、扩展名、目录
    assert_eq!(hit_names(&names(&h, "会议纪要")), vec!["会议纪要.md"]);
    let todo = names(&h, "TODO");
    assert_eq!(hit_names(&todo), vec!["todo.txt"]);
    assert!(todo.hits[0].name_parts.iter().any(|p| p.hit && p.text == "todo"));
    assert!(names(&h, "会议").hits.iter().any(|h| h.is_dir && h.name == "会议"));
    // 依赖目录不收录
    assert!(names(&h, "index.js").hits.is_empty());
    // 隐藏目录只收录自身，不进入内部
    assert!(names(&h, ".toolcache").hits.iter().any(|h| h.is_dir));
    assert!(names(&h, "cached.md").hits.is_empty());
    assert!(contents(&h, "hiddenToolData").hits.is_empty());
    // 软件安装目录只收录文件名
    assert_eq!(hit_names(&names(&h, "manual.txt")), vec!["manual.txt"]);
    assert!(contents(&h, "programManualText").hits.is_empty());
    assert_eq!(content_names(&contents(&h, "downloadedContract")), vec!["合同.txt"]);
    // 多词：所有词都要出现在名字中
    assert_eq!(hit_names(&names(&h, "季度 docx")), vec!["季度报告.docx"]);

    // 内容：中文短语、英文忽略大小写、Office 文档
    let r = contents(&h, "倒排索引");
    assert_eq!(content_names(&r), vec!["会议纪要.md"]);
    assert_eq!(r.hits[0].snippets[0].line, 4);
    assert!(r.hits[0].snippets[0].parts.iter().any(|p| p.hit && p.text == "倒排索引"));
    assert_eq!(content_names(&contents(&h, "alice noteboard")), vec!["todo.txt"]);
    assert_eq!(content_names(&contents(&h, "营收增长")), vec!["季度报告.docx"]);
    // 粘贴一段文字（含换行）：按词全部命中
    assert_eq!(content_names(&contents(&h, "本周讨论本地文件搜索方案。\n结论：采用倒排索引")), vec!["会议纪要.md"]);
    assert!(contents(&h, "secretToken").hits.is_empty());
    assert!(contents(&h, "不存在的内容片段").hits.is_empty());
}

#[test]
fn incremental_updates_follow_file_changes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("notes");
    sample_tree(&root);
    let h = start(&root, None);

    // 修改：旧内容不再命中，新内容可搜
    let todo = root.join("todo.txt");
    fs::write(&todo, "Call Bob tomorrow, longer content now").unwrap();
    h.send(Msg::Fs { paths: vec![todo.clone()], rescan: None });
    wait_idle(&h);
    assert!(contents(&h, "alice").hits.is_empty());
    assert_eq!(content_names(&contents(&h, "bob tomorrow")), vec!["todo.txt"]);

    // 删除
    let minutes = root.join("项目/会议/会议纪要.md");
    fs::remove_file(&minutes).unwrap();
    h.send(Msg::Fs { paths: vec![minutes], rescan: None });
    wait_idle(&h);
    assert!(names(&h, "会议纪要").hits.is_empty());
    assert!(contents(&h, "倒排索引").hits.is_empty());

    // 整个目录移入：子树被扫描收录
    let staging = dir.path().join("外部资料");
    fs::create_dir_all(staging.join("深层/更深")).unwrap();
    fs::write(staging.join("深层/更深/灵感.md"), "向量检索与倒排结合").unwrap();
    let moved = root.join("外部资料");
    fs::rename(&staging, &moved).unwrap();
    h.send(Msg::Fs { paths: vec![moved.clone()], rescan: None });
    wait_idle(&h);
    assert_eq!(hit_names(&names(&h, "灵感")), vec!["灵感.md"]);
    assert_eq!(content_names(&contents(&h, "向量检索")), vec!["灵感.md"]);

    // 上级目录尚未收录的新文件：回退为重扫已知目录
    fs::create_dir_all(root.join("新目录/子目录")).unwrap();
    let fresh = root.join("新目录/子目录/新笔记.txt");
    fs::write(&fresh, "fresh content here").unwrap();
    h.send(Msg::Fs { paths: vec![fresh], rescan: None });
    wait_idle(&h);
    assert_eq!(hit_names(&names(&h, "新笔记")), vec!["新笔记.txt"]);

    // 整盘重扫（监听溢出）同样能发现遗漏
    fs::write(root.join("遗漏.md"), "missed by watcher").unwrap();
    h.send(Msg::Fs { paths: Vec::new(), rescan: Some(root.clone()) });
    wait_idle(&h);
    assert_eq!(content_names(&contents(&h, "missed watcher")), vec!["遗漏.md"]);
}

#[test]
fn snapshot_reload_serves_queries_and_reconciles_changes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("notes");
    let snap = dir.path().join("snap/index.bin");
    sample_tree(&root);
    let h = start(&root, Some(snap.clone()));
    h.send(Msg::SaveNow);
    wait_idle(&h);
    assert!(snap.exists());
    h.send(Msg::Shutdown);

    // 离线期间新增与删除文件
    fs::write(root.join("离线新增.md"), "offline addition").unwrap();
    fs::remove_file(root.join("todo.txt")).unwrap();

    let h2 = start(&root, Some(snap.clone()));
    assert_eq!(content_names(&contents(&h2, "倒排索引")), vec!["会议纪要.md"]);
    assert_eq!(content_names(&contents(&h2, "offline addition")), vec!["离线新增.md"]);
    assert!(names(&h2, "todo").hits.is_empty());

    // 关闭后清空索引并删除快照
    h2.send(Msg::Configure { enabled: false, roots: Vec::new(), delay: Duration::ZERO });
    wait_idle(&h2);
    assert!(!snap.exists());
    assert!(names(&h2, "会议纪要").hits.is_empty());
}

#[test]
fn roots_can_be_added_removed_and_nested_roots_are_merged() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    fs::create_dir_all(a.join("inner")).unwrap();
    fs::create_dir_all(&b).unwrap();
    fs::write(a.join("inner/alpha.md"), "alpha text").unwrap();
    fs::write(b.join("beta.md"), "beta text").unwrap();
    let h = Engine::spawn(None, Box::new(|| {}), false);
    let s = |p: &Path| p.to_string_lossy().to_string();
    // 嵌套位置（a/inner 位于 a 之内）只索引一次
    h.send(Msg::Configure { enabled: true, roots: vec![s(&a), s(&a.join("inner")), s(&b)], delay: Duration::ZERO });
    wait_idle(&h);
    assert_eq!(names(&h, "alpha").hits.len(), 1);
    assert_eq!(names(&h, "beta").hits.len(), 1);
    // 移除位置 b
    h.send(Msg::Configure { enabled: true, roots: vec![s(&a)], delay: Duration::ZERO });
    wait_idle(&h);
    assert!(names(&h, "beta").hits.is_empty());
    assert!(contents(&h, "beta text").hits.is_empty());
    assert_eq!(content_names(&contents(&h, "alpha text")), vec!["alpha.md"]);
}

/// 性能基准（手动运行）：NB_BENCH_ROOT 指定真实目录或整盘，输出建索引耗时、索引规模与查询耗时
/// cargo test --release --lib local_search::tests::bench_real_directory -- --ignored --nocapture
#[test]
#[ignore]
fn bench_real_directory() {
    let Some(root) = std::env::var_os("NB_BENCH_ROOT") else { return };
    let snap = std::env::temp_dir().join("nb-local-search-bench.bin");
    let _ = fs::remove_file(&snap);
    let started = Instant::now();
    let h = Engine::spawn(Some(snap.clone()), Box::new(|| {}), false);
    h.send(Msg::Configure { enabled: true, roots: vec![root.to_string_lossy().to_string()], delay: Duration::ZERO });
    // 建索引期间持续查询，记录最长查询耗时（验证建索引时查询不卡顿）
    let mut worst_during_build = Duration::ZERO;
    loop {
        let (tx, rx) = crossbeam_channel::bounded(1);
        h.send(Msg::Probe(tx));
        if rx.recv().unwrap_or(false) {
            break;
        }
        let t = Instant::now();
        let _ = names(&h, "readme");
        worst_during_build = worst_during_build.max(t.elapsed());
        std::thread::sleep(Duration::from_millis(200));
    }
    wait_idle(&h);
    let build = started.elapsed();
    {
        let idx = h.shared.index.read().unwrap();
        println!(
            "建索引 {:?}：条目 {}，内容文档 {}，段 {}，名字池 {} KB，内容索引约 {} KB；建索引期间最长查询 {:?}",
            build,
            idx.table.live_count(),
            idx.content.live_docs(),
            idx.content.segments.len(),
            idx.table.names.len() / 1024,
            idx.content.bytes() / 1024,
            worst_during_build
        );
        // 按根目录下两级目录统计内容文档数量与体积，便于找出噪音来源
        let mut groups: std::collections::HashMap<String, (usize, u64)> = std::collections::HashMap::new();
        let root_s = root.to_string_lossy().to_string();
        for (id, e) in idx.table.entries.iter().enumerate() {
            if !e.alive() || !e.has_doc() {
                continue;
            }
            let path = idx.table.path(id as u32);
            let rest = path.strip_prefix(&root_s).unwrap_or(&path).trim_start_matches(['\\', '/']);
            let key: Vec<&str> = rest.split(['\\', '/']).take(2).collect();
            let key = if key.len() > 1 { key.join("/") } else { "(根目录文件)".to_string() };
            let g = groups.entry(key).or_default();
            g.0 += 1;
            g.1 += e.size();
        }
        let mut list: Vec<_> = groups.into_iter().collect();
        list.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
        for (k, (n, bytes)) in list.into_iter().take(25) {
            println!("  {:>7} 个 {:>8} KB  {}", n, bytes / 1024, k);
        }
    }
    let queries: Vec<String> = std::env::var("NB_BENCH_QUERIES")
        .unwrap_or_else(|_| "readme|notes|会议|function|import React|本地文件搜索|a".into())
        .split('|')
        .map(String::from)
        .collect();
    for q in &queries {
        let t = Instant::now();
        let n = names(&h, q);
        let tn = t.elapsed();
        let t = Instant::now();
        let c = contents(&h, q);
        let tc = t.elapsed();
        println!("查询「{}」：文件名 {} 条 / {:?}；内容 {} 个文件 / {:?}{}", q, n.total, tn, c.hits.len(), tc, if c.truncated { "（截断）" } else { "" });
    }
    let t = Instant::now();
    h.send(Msg::SaveNow);
    wait_idle(&h);
    println!("保存快照 {:?}，大小 {} KB", t.elapsed(), fs::metadata(&snap).map(|m| m.len() / 1024).unwrap_or(0));
    let t = Instant::now();
    let loaded = super::persist::load(&snap).expect("快照可读回");
    println!("读取快照 {:?}（{} 条目）", t.elapsed(), loaded.0.live_count());
    let _ = fs::remove_file(&snap);
}

#[test]
fn many_files_are_indexed_and_name_search_ranks_exact_first() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("many");
    for d in 0..20 {
        let sub = root.join(format!("dir{d}"));
        fs::create_dir_all(&sub).unwrap();
        for f in 0..100 {
            fs::write(sub.join(format!("note_{d}_{f}.md")), format!("内容编号 {d}-{f} common")).unwrap();
        }
    }
    fs::write(root.join("note.md"), "exact").unwrap();
    let h = start(&root, None);
    let r = names(&h, "note.md");
    assert_eq!(r.hits[0].name, "note.md");
    assert_eq!(r.total, 1);
    let all = names(&h, "note");
    assert_eq!(all.total, 2001);
    assert_eq!(all.hits.len(), 50);
    let r = contents(&h, "内容编号 13-57");
    assert_eq!(content_names(&r), vec!["note_13_57.md"]);
    // 大量命中时按数量上限截断
    let many = contents(&h, "common");
    assert_eq!(many.hits.len(), 50);
    assert!(many.truncated);
}
