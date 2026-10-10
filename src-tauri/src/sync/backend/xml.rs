// 极简 XML 片段提取：WebDAV PROPFIND 与 S3 ListObjectsV2 只需要按标签名取文本，
// 不同服务的命名空间前缀不一致（D:/d:/lp1:/无前缀），这里按「本地名」匹配并忽略前缀。

/// 提取所有本地名为 `name` 的元素内部文本（不支持同名元素嵌套，足够解析上述响应）
pub fn elements(xml: &str, name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = xml.as_bytes();
    let mut i = 0;
    while let Some(rel) = xml[i..].find('<') {
        let start = i + rel;
        // 解析开始标签名
        let tag_end = match xml[start..].find('>') {
            Some(e) => start + e,
            None => break,
        };
        let raw = &xml[start + 1..tag_end];
        if raw.starts_with('/') || raw.starts_with('?') || raw.starts_with('!') {
            i = tag_end + 1;
            continue;
        }
        let self_closing = raw.ends_with('/');
        let tag_name = raw.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
        let local = tag_name.rsplit(':').next().unwrap_or(tag_name);
        if local != name {
            i = tag_end + 1;
            continue;
        }
        if self_closing {
            out.push(String::new());
            i = tag_end + 1;
            continue;
        }
        // 查找匹配的结束标签（允许任意前缀）
        let mut j = tag_end + 1;
        let mut found = None;
        while let Some(rel_close) = xml[j..].find("</") {
            let close_start = j + rel_close;
            let close_end = match xml[close_start..].find('>') {
                Some(e) => close_start + e,
                None => break,
            };
            let close_name = xml[close_start + 2..close_end].trim();
            let close_local = close_name.rsplit(':').next().unwrap_or(close_name);
            if close_local == name {
                found = Some((close_start, close_end));
                break;
            }
            j = close_end + 1;
        }
        match found {
            Some((cs, ce)) => {
                out.push(xml[tag_end + 1..cs].to_string());
                i = ce + 1;
            }
            None => break,
        }
        if i >= bytes.len() {
            break;
        }
    }
    out
}

/// 第一个匹配元素的文本（已反转义）
pub fn first_text(xml: &str, name: &str) -> Option<String> {
    elements(xml, name).into_iter().next().map(|s| unescape(s.trim()))
}

/// 反转义 XML 实体
pub fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_elements_ignoring_prefix() {
        let xml = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/a%20b.md</d:href><d:propstat><d:prop><d:getcontentlength>12</d:getcontentlength><d:resourcetype/></d:prop></d:propstat></d:response><D:response><D:href>/dav/dir/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response></d:multistatus>"#;
        let responses = elements(xml, "response");
        assert_eq!(responses.len(), 2);
        assert_eq!(first_text(&responses[0], "href").unwrap(), "/dav/a%20b.md");
        assert_eq!(first_text(&responses[0], "getcontentlength").unwrap(), "12");
        assert!(elements(&responses[1], "collection").len() == 1);
        assert!(elements(&responses[0], "collection").is_empty());
    }

    #[test]
    fn unescapes_entities() {
        assert_eq!(unescape("a &amp; b &lt;c&gt;"), "a & b <c>");
    }
}
