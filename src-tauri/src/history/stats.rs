// NoteBoard 文档历史记录：改动摘要统计
//
// 记录版本时计算与上一版本相比的改动量，时间线直接显示「新增 12 字 · 删除 3 字」，
// 无需前端逐条加载正文：
//   - 文本类（Markdown / 代码）：按行对齐改动块，块内剥离公共前后缀后按字符计数
//   - 画板：按元素 id 统计新增 / 删除 / 修改（忽略版本号、随机种子等每次保存都会变的字段）
//   - 思维导图：按节点 id 统计
//   - 多维表格：按行 id 统计
// 解析失败时退回文本统计。

use super::model::Stats;
use serde_json::Value;
use std::collections::HashMap;

/// 计算改动统计；old 为 None 表示首个版本（不统计）
pub fn compute(kind: &str, old: Option<&[u8]>, new: &[u8]) -> Option<Stats> {
    let old = old?;
    let structured = match kind {
        "board" => element_stats(old, new, board_items, "element"),
        "mindmap" => element_stats(old, new, mindmap_items, "node"),
        "bitable" => element_stats(old, new, bitable_items, "row"),
        _ => None,
    };
    structured.or_else(|| text_stats(&String::from_utf8_lossy(old), &String::from_utf8_lossy(new)))
}

/// 统计时忽略的字符（换行不计入字数）
fn count_chars(s: &str) -> u64 {
    s.chars().filter(|c| *c != '\n' && *c != '\r').count() as u64
}

/// 剥离公共前后缀后各自剩余的字符数（删除, 新增）
fn trimmed_delta(a: &str, b: &str) -> (u64, u64) {
    let av: Vec<char> = a.chars().collect();
    let bv: Vec<char> = b.chars().collect();
    let mut pre = 0;
    while pre < av.len() && pre < bv.len() && av[pre] == bv[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < av.len() - pre && suf < bv.len() - pre && av[av.len() - 1 - suf] == bv[bv.len() - 1 - suf] {
        suf += 1;
    }
    let del: String = av[pre..av.len() - suf].iter().collect();
    let ins: String = bv[pre..bv.len() - suf].iter().collect();
    (count_chars(&del), count_chars(&ins))
}

/// 文本按字符统计改动
pub fn text_stats(old: &str, new: &str) -> Option<Stats> {
    let (mut ins, mut del) = (0u64, 0u64);
    match crate::sync::diff3::line_hunks(old, new) {
        Some((a, b, hunks)) => {
            for (os, oe, xs, xe) in hunks {
                let (d, i) = trimmed_delta(&a[os..oe].concat(), &b[xs..xe].concat());
                del += d;
                ins += i;
            }
        }
        // 改动过大：整体剥离前后缀估算
        None => {
            let (d, i) = trimmed_delta(old, new);
            del = d;
            ins = i;
        }
    }
    Some(Stats { ins, del, modified: 0, unit: "char".into() })
}

type Items = HashMap<String, String>;

/// 按 id 比较两组元素（id → 规范化内容）
fn element_stats(old: &[u8], new: &[u8], extract: fn(&Value) -> Option<Items>, unit: &str) -> Option<Stats> {
    let a = extract(&serde_json::from_slice(old).ok()?)?;
    let b = extract(&serde_json::from_slice(new).ok()?)?;
    let mut stats = Stats { unit: unit.into(), ..Default::default() };
    for (id, body) in &b {
        match a.get(id) {
            None => stats.ins += 1,
            Some(prev) if prev != body => stats.modified += 1,
            _ => {}
        }
    }
    stats.del = a.keys().filter(|id| !b.contains_key(*id)).count() as u64;
    Some(stats)
}

/// 画板元素：跳过已删除元素，去掉每次保存都会变化的字段
fn board_items(v: &Value) -> Option<Items> {
    let mut out = Items::new();
    for el in v.get("elements")?.as_array()? {
        if el.get("isDeleted").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let Some(id) = el.get("id").and_then(Value::as_str) else { continue };
        let mut el = el.clone();
        if let Some(obj) = el.as_object_mut() {
            for k in ["version", "versionNonce", "updated", "seed", "index"] {
                obj.remove(k);
            }
        }
        out.insert(id.to_string(), el.to_string());
    }
    Some(out)
}

/// 导图节点：节点自身内容 + 父节点 + 同级顺序（移动也算修改）
fn mindmap_items(v: &Value) -> Option<Items> {
    let root = v.get("root")?;
    let mut out = Items::new();
    let mut stack: Vec<(&Value, String, usize)> = vec![(root, String::new(), 0)];
    while let Some((node, parent, order)) = stack.pop() {
        let Some(id) = node.get("id").and_then(Value::as_str) else { continue };
        let mut own = node.clone();
        if let Some(obj) = own.as_object_mut() {
            obj.remove("children");
            obj.remove("isExpanded");
        }
        out.insert(id.to_string(), format!("{}|{}|{}", parent, order, own));
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            for (i, c) in children.iter().enumerate() {
                stack.push((c, id.to_string(), i));
            }
        }
    }
    Some(out)
}

/// 表格行：去掉自动维护的更新时间
fn bitable_items(v: &Value) -> Option<Items> {
    let mut out = Items::new();
    for row in v.get("rows")?.as_array()? {
        let Some(id) = row.get("id").and_then(Value::as_str) else { continue };
        let mut row = row.clone();
        if let Some(obj) = row.as_object_mut() {
            obj.remove("_updatedAt");
        }
        out.insert(id.to_string(), row.to_string());
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_counts_changed_chars_only() {
        let s = text_stats("第一行\n第二行内容\n第三行\n", "第一行\n第二行新内容\n第三行\n新增\n").unwrap();
        assert_eq!(s.ins, 3);
        assert_eq!(s.del, 0);
        let s = text_stats("abc", "").unwrap();
        assert_eq!((s.ins, s.del), (0, 3));
    }

    #[test]
    fn board_ignores_volatile_fields() {
        let old = br#"{"elements":[{"id":"a","x":1,"version":1},{"id":"b","x":2},{"id":"c","isDeleted":true}]}"#;
        let new = br#"{"elements":[{"id":"a","x":1,"version":5},{"id":"b","x":3},{"id":"d","x":0}]}"#;
        let s = compute("board", Some(old), new).unwrap();
        assert_eq!((s.ins, s.del, s.modified), (1, 0, 1));
        assert_eq!(s.unit, "element");
    }

    #[test]
    fn mindmap_counts_nodes() {
        let old = br#"{"root":{"id":"r","text":"root","children":[{"id":"a","text":"A","children":[]}]}}"#;
        let new = br#"{"root":{"id":"r","text":"root","children":[{"id":"b","text":"B","children":[]},{"id":"a","text":"A2","children":[]}]}}"#;
        let s = compute("mindmap", Some(old), new).unwrap();
        assert_eq!((s.ins, s.del, s.modified), (1, 0, 1));
    }

    #[test]
    fn invalid_json_falls_back_to_text() {
        let s = compute("board", Some(b"x"), b"xy").unwrap();
        assert_eq!(s.unit, "char");
        assert!(compute("markdown", None, b"x").is_none());
    }
}
