// 本地文件搜索：文本切分与匹配工具
//
// 内容索引按「片段」建立倒排表：
//   - 汉字、假名、谚文等不以空格分词的文字记单字与相邻两字（含与其相邻的任意字符）；
//   - 其余字符（英文、数字、符号）记连续三字；
//   - 片段不跨越空白，查询词按空白切分，因此查询词的片段一定是正文片段的子集。
// 规则只取决于窗口内的字符本身，保证「正文包含查询词 ⇒ 正文片段 ⊇ 查询词片段」。

/// 超过该长度且不含中日韩文字的连续串视为编码数据（Base64 图片、压缩图表等），不建片段。
pub const MAX_PLAIN_RUN: usize = 1024;

/// 是否为不以空格分词的中日韩文字（含全角标点）
#[inline]
pub fn is_cjk(c: char) -> bool {
    let u = c as u32;
    matches!(
        u,
        0x2E80..=0x2FDF
            | 0x3000..=0x303F
            | 0x3040..=0x30FF
            | 0x3100..=0x312F
            | 0x3130..=0x318F
            | 0x31A0..=0x31FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xAC00..=0xD7AF
            | 0xF900..=0xFAFF
            | 0xFF00..=0xFFEF
            | 0x20000..=0x2FA1F
    )
}

/// 大小写折叠：一个字符只映射为一个字符，保证折叠前后字符位置一一对应（片段截取依赖这一点）。
#[inline]
pub fn fold(c: char) -> char {
    if c.is_ascii() {
        c.to_ascii_lowercase()
    } else {
        c.to_lowercase().next().unwrap_or(c)
    }
}

/// 折叠整段文字（逐字符一一对应）
pub fn fold_str(text: &str) -> String {
    // 纯 ASCII 走快速路径，避免逐字符 Unicode 查表
    if text.is_ascii() {
        return text.to_ascii_lowercase();
    }
    text.chars().map(fold).collect()
}

#[inline]
fn mix(h: u32, x: u32) -> u32 {
    (h.rotate_left(5) ^ x).wrapping_mul(0x9E37_79B9)
}

#[inline]
fn gram1(a: char) -> u32 {
    mix(mix(0x51, 1), a as u32)
}

#[inline]
fn gram2(a: char, b: char) -> u32 {
    mix(mix(mix(0x52, 2), a as u32), b as u32)
}

#[inline]
fn gram3(a: char, b: char, c: char) -> u32 {
    mix(mix(mix(mix(0x53, 3), a as u32), b as u32), c as u32)
}

/// 为一段不含空白的折叠字符串生成片段
pub fn grams_of_run(run: &[char], out: &mut Vec<u32>) {
    let n = run.len();
    // 过长且不含中日韩文字的串多为编码数据，跳过以免撑大索引
    if n > MAX_PLAIN_RUN && !run.iter().any(|c| is_cjk(*c)) {
        return;
    }
    for i in 0..n {
        let a = run[i];
        let ca = is_cjk(a);
        if ca {
            out.push(gram1(a));
        }
        if i + 1 < n {
            let b = run[i + 1];
            let cb = is_cjk(b);
            if ca || cb {
                out.push(gram2(a, b));
            }
            if i + 2 < n {
                let c = run[i + 2];
                if !ca && !cb && !is_cjk(c) {
                    out.push(gram3(a, b, c));
                }
            }
        }
    }
}

/// 为整篇正文生成去重后的片段集合（升序）
pub fn doc_grams(text: &str) -> Vec<u32> {
    let mut out = Vec::with_capacity(text.len().min(1 << 20));
    let mut run: Vec<char> = Vec::with_capacity(256);
    for c in text.chars() {
        if c.is_whitespace() {
            if !run.is_empty() {
                grams_of_run(&run, &mut out);
                run.clear();
            }
        } else {
            run.push(fold(c));
        }
    }
    if !run.is_empty() {
        grams_of_run(&run, &mut out);
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// 查询词
#[derive(Debug, Clone)]
pub struct Term {
    /// 折叠后的查询词
    pub folded: String,
    /// 是否按完整路径匹配（文件名搜索中包含路径分隔符的词）
    pub is_path: bool,
    /// 内容索引片段（为空表示该词太短，无法用索引缩小范围）
    pub grams: Vec<u32>,
}

/// 解析后的查询
#[derive(Debug, Clone)]
pub struct Query {
    pub terms: Vec<Term>,
    /// 多个词时的整句（单个空格连接），用于整句命中加分
    pub phrase: Option<String>,
}

/// 单次查询最多使用的词数（粘贴整段文字时防止过度消耗）
const MAX_TERMS: usize = 64;

impl Query {
    /// 按空白切分查询文字；重复词（忽略大小写）只保留一个
    pub fn parse(input: &str) -> Query {
        let mut terms: Vec<Term> = Vec::new();
        let mut words: Vec<String> = Vec::new();
        for word in input.split_whitespace() {
            let folded = fold_str(word);
            if words.contains(&folded) {
                continue;
            }
            words.push(folded.clone());
            if terms.len() >= MAX_TERMS {
                continue;
            }
            let chars: Vec<char> = folded.chars().collect();
            let mut grams = Vec::new();
            grams_of_run(&chars, &mut grams);
            grams.sort_unstable();
            grams.dedup();
            let is_path = folded.contains('/') || folded.contains('\\');
            terms.push(Term { folded, is_path, grams });
        }
        let phrase = if words.len() > 1 { Some(words.join(" ")) } else { None };
        Query { terms, phrase }
    }

    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }

    /// 是否有可用于内容索引的词
    pub fn has_content_grams(&self) -> bool {
        self.terms.iter().any(|t| !t.grams.is_empty())
    }
}

/// 高亮片段：文字与是否为命中部分
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct Part {
    pub text: String,
    pub hit: bool,
}

/// 在一行文字中查找所有查询词，返回命中的字符区间（已合并、升序）
pub fn find_ranges(line: &str, terms: &[&str]) -> Vec<(usize, usize)> {
    let folded: Vec<char> = line.chars().map(fold).collect();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for term in terms {
        let needle: Vec<char> = term.chars().collect();
        if needle.is_empty() || needle.len() > folded.len() {
            continue;
        }
        let mut i = 0;
        while i + needle.len() <= folded.len() {
            if folded[i..i + needle.len()] == needle[..] {
                ranges.push((i, i + needle.len()));
                i += needle.len();
            } else {
                i += 1;
            }
        }
    }
    ranges.sort_unstable();
    // 合并重叠或相邻区间
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for (s, e) in ranges {
        if let Some(last) = merged.last_mut() {
            if s <= last.1 {
                last.1 = last.1.max(e);
                continue;
            }
        }
        merged.push((s, e));
    }
    merged
}

/// 按命中区间把文字切成高亮片段；文字过长时以第一个命中为中心截取，前后加省略号
pub fn highlight(line: &str, ranges: &[(usize, usize)], max_chars: usize) -> Vec<Part> {
    let chars: Vec<char> = line.chars().collect();
    let total = chars.len();
    let (mut start, mut end) = (0usize, total);
    if total > max_chars {
        let first = ranges.first().map(|r| r.0).unwrap_or(0);
        // 命中位置前保留约四分之一窗口，便于看到上下文
        start = first.saturating_sub(max_chars / 4);
        end = (start + max_chars).min(total);
        if end - start < max_chars {
            start = end.saturating_sub(max_chars);
        }
    }
    let mut parts: Vec<Part> = Vec::new();
    let push = |parts: &mut Vec<Part>, text: String, hit: bool| {
        if text.is_empty() {
            return;
        }
        if let Some(last) = parts.last_mut() {
            if last.hit == hit {
                last.text.push_str(&text);
                return;
            }
        }
        parts.push(Part { text, hit });
    };
    if start > 0 {
        push(&mut parts, "…".to_string(), false);
    }
    let mut pos = start;
    for &(s, e) in ranges {
        if e <= start || s >= end {
            continue;
        }
        let s = s.max(start);
        let e = e.min(end);
        if s > pos {
            push(&mut parts, chars[pos..s].iter().collect(), false);
        }
        push(&mut parts, chars[s..e].iter().collect(), true);
        pos = e;
    }
    if pos < end {
        push(&mut parts, chars[pos..end].iter().collect(), false);
    }
    if end < total {
        push(&mut parts, "…".to_string(), false);
    }
    parts
}

/// 折叠空白：连续空白合并为单个空格（整句匹配使用）
pub fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            if !in_space && !out.is_empty() {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 正文中任意不含空白的子串，其片段都必须是正文片段的子集（索引不会漏掉真实命中）
    #[test]
    fn query_grams_are_subset_of_document_grams() {
        let text = "NoteBoard 本地文件搜索：支持 Markdown、代码与纯文本。Hello世界abc 123-456 ÄÖÜ äöü";
        let doc = doc_grams(text);
        for run in text.split_whitespace() {
            let chars: Vec<char> = run.chars().collect();
            for start in 0..chars.len() {
                for end in start + 1..=chars.len() {
                    let piece: String = chars[start..end].iter().collect();
                    let query = Query::parse(&piece);
                    for term in &query.terms {
                        for gram in &term.grams {
                            assert!(doc.binary_search(gram).is_ok(), "片段缺失：{}", piece);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn short_ascii_terms_have_no_grams_but_cjk_does() {
        let q = Query::parse("ab 猫 会议");
        assert!(q.terms[0].grams.is_empty());
        assert!(!q.terms[1].grams.is_empty());
        assert!(!q.terms[2].grams.is_empty());
        assert_eq!(q.phrase.as_deref(), Some("ab 猫 会议"));
    }

    #[test]
    fn parse_dedupes_case_insensitively_and_marks_path_terms() {
        let q = Query::parse("Note note docs/readme");
        assert_eq!(q.terms.len(), 2);
        assert!(q.terms[1].is_path);
    }

    #[test]
    fn long_encoded_runs_are_skipped() {
        let blob = "A".repeat(MAX_PLAIN_RUN + 10);
        assert!(doc_grams(&blob).is_empty());
        // 含中文的长串（中文段落没有空格）仍然建立片段
        let zh = "中".repeat(MAX_PLAIN_RUN + 10);
        assert!(!doc_grams(&zh).is_empty());
    }

    #[test]
    fn highlight_marks_hits_and_trims_long_lines() {
        let ranges = find_ranges("Hello World hello", &["hello"]);
        assert_eq!(ranges, vec![(0, 5), (12, 17)]);
        let parts = highlight("Hello World hello", &ranges, 200);
        assert_eq!(parts[0], Part { text: "Hello".into(), hit: true });
        assert_eq!(parts[1], Part { text: " World ".into(), hit: false });
        let long = format!("{}关键字{}", "前".repeat(300), "后".repeat(300));
        let ranges = find_ranges(&long, &["关键字"]);
        let parts = highlight(&long, &ranges, 80);
        let joined: String = parts.iter().map(|p| p.text.as_str()).collect();
        assert!(joined.starts_with('…') && joined.ends_with('…'));
        assert!(parts.iter().any(|p| p.hit && p.text == "关键字"));
    }

    #[test]
    fn collapse_whitespace_normalizes_line_breaks() {
        assert_eq!(collapse_whitespace("  a \r\n\t b  "), "a b");
    }
}
