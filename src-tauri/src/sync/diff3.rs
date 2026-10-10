// NoteBoard 行级三方合并
//
// 以上次同步时的内容为基线（base），分别计算本机（local）与远端（remote）相对基线的改动块：
//   - 只有一方改动的块：直接采用该方改动（两端各自改不同段落时都能保留）
//   - 双方改动重叠且结果不同的块：采用较新的一方（与「同时修改只保留最新结果」的规则一致）
// 差异算法为 Myers O((N+M)D)；改动规模超过上限时放弃行级合并，由调用方回退到文档级覆盖。

/// 改动块：基线 [os, oe) 被替换为对方的 [xs, xe)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Hunk {
    os: usize,
    oe: usize,
    xs: usize,
    xe: usize,
    /// true 表示来自本机（a），false 表示来自远端（b）
    from_a: bool,
}

/// 行级合并结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeOutcome {
    pub text: String,
    /// 双方重叠改动、按较新一方处理的块数
    pub conflicts: usize,
}

/// 差异编辑距离上限（超过则认为改动过大，不做行级合并）
const MAX_EDIT_DISTANCE: usize = 4000;

/// 按行切分，保留行尾换行符（CRLF/LF 原样参与比较与输出）
fn lines(s: &str) -> Vec<&str> {
    s.split_inclusive('\n').collect()
}

/// Myers 差异：返回最长公共子序列的匹配对（a 下标, b 下标），升序
fn myers(a: &[&str], b: &[&str], max_d: usize) -> Option<Vec<(usize, usize)>> {
    let n = a.len() as isize;
    let m = b.len() as isize;
    let max = n + m;
    let off = max + 1;
    let mut v = vec![0isize; (2 * max + 3) as usize];
    // trace[d]：第 d 步开始前 v 在 k ∈ [-d-1, d+1] 区间的快照（回溯用，内存 O(D²)）
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut found = false;
    'outer: for d in 0..=max {
        if d as usize > max_d {
            return None;
        }
        let lo = (off - d - 1) as usize;
        let hi = (off + d + 1) as usize;
        trace.push(v[lo..=hi].to_vec());
        let mut k = -d;
        while k <= d {
            let idx = (k + off) as usize;
            let mut x = if k == -d || (k != d && v[idx - 1] < v[idx + 1]) { v[idx + 1] } else { v[idx - 1] + 1 };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[idx] = x;
            if x >= n && y >= m {
                found = true;
                break 'outer;
            }
            k += 2;
        }
    }
    if !found {
        return None;
    }
    let mut pairs = Vec::new();
    let mut x = n;
    let mut y = m;
    for d in (0..trace.len()).rev() {
        let di = d as isize;
        let snap = &trace[d];
        let get = |k: isize| snap[(k + di + 1) as usize];
        let k = x - y;
        let prev_k = if k == -di || (k != di && get(k - 1) < get(k + 1)) { k + 1 } else { k - 1 };
        let prev_x = get(prev_k);
        let prev_y = prev_x - prev_k;
        while x > prev_x && y > prev_y {
            x -= 1;
            y -= 1;
            pairs.push((x as usize, y as usize));
        }
        if d > 0 {
            x = prev_x;
            y = prev_y;
        }
    }
    pairs.reverse();
    Some(pairs)
}

/// 先剥离公共前后缀再做 Myers（局部修改时大幅缩小计算规模）
fn lcs_pairs(a: &[&str], b: &[&str]) -> Option<Vec<(usize, usize)>> {
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    let mid = myers(&a[pre..a.len() - suf], &b[pre..b.len() - suf], MAX_EDIT_DISTANCE)?;
    let mut pairs: Vec<(usize, usize)> = (0..pre).map(|i| (i, i)).collect();
    pairs.extend(mid.into_iter().map(|(x, y)| (x + pre, y + pre)));
    pairs.extend((0..suf).map(|i| (a.len() - suf + i, b.len() - suf + i)));
    Some(pairs)
}

/// 由匹配对生成改动块
fn hunks(o_len: usize, x_len: usize, pairs: &[(usize, usize)], from_a: bool) -> Vec<Hunk> {
    let mut out = Vec::new();
    let (mut po, mut px) = (0usize, 0usize);
    for &(oi, xi) in pairs {
        if oi > po || xi > px {
            out.push(Hunk { os: po, oe: oi, xs: px, xe: xi, from_a });
        }
        po = oi + 1;
        px = xi + 1;
    }
    if po < o_len || px < x_len {
        out.push(Hunk { os: po, oe: o_len, xs: px, xe: x_len, from_a });
    }
    out
}

/// 某一方在基线区间 [gs, ge) 上的最终文本（区间内未被该方改动的行保持基线原样）
fn side_region<'a>(o: &[&'a str], x: &[&'a str], group: &[Hunk], from_a: bool, gs: usize, ge: usize) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut cur = gs;
    for h in group.iter().filter(|h| h.from_a == from_a) {
        out.extend_from_slice(&o[cur..h.os]);
        out.extend_from_slice(&x[h.xs..h.xe]);
        cur = h.oe;
    }
    out.extend_from_slice(&o[cur..ge]);
    out
}

/// 三方合并；`prefer_local` 决定双方重叠改动时采用哪一方。改动过大无法计算时返回 None
pub fn merge_text(base: &str, local: &str, remote: &str, prefer_local: bool) -> Option<MergeOutcome> {
    if local == remote || remote == base {
        return Some(MergeOutcome { text: local.to_string(), conflicts: 0 });
    }
    if local == base {
        return Some(MergeOutcome { text: remote.to_string(), conflicts: 0 });
    }
    let o = lines(base);
    let a = lines(local);
    let b = lines(remote);
    let mut all = hunks(o.len(), a.len(), &lcs_pairs(&o, &a)?, true);
    all.extend(hunks(o.len(), b.len(), &lcs_pairs(&o, &b)?, false));
    // 按基线位置排序；同起点时空插入在前，保证分组判断稳定
    all.sort_by_key(|h| (h.os, h.oe, !h.from_a));

    let mut out: Vec<&str> = Vec::new();
    let mut conflicts = 0;
    let mut pos = 0usize;
    let mut i = 0usize;
    while i < all.len() {
        let mut group = vec![all[i]];
        let gs = all[i].os;
        let mut ge = all[i].oe;
        i += 1;
        // 重叠判定：起点落在组区间内，或与组同起点（同一位置的插入顺序无法确定，视为重叠）
        while i < all.len() && (all[i].os < ge || all[i].os == gs) {
            ge = ge.max(all[i].oe);
            group.push(all[i]);
            i += 1;
        }
        out.extend_from_slice(&o[pos..gs]);
        let has_a = group.iter().any(|h| h.from_a);
        let has_b = group.iter().any(|h| !h.from_a);
        if has_a && has_b {
            let ra = side_region(&o, &a, &group, true, gs, ge);
            let rb = side_region(&o, &b, &group, false, gs, ge);
            if ra == rb {
                out.extend(ra);
            } else {
                conflicts += 1;
                out.extend(if prefer_local { ra } else { rb });
            }
        } else if has_a {
            out.extend(side_region(&o, &a, &group, true, gs, ge));
        } else {
            out.extend(side_region(&o, &b, &group, false, gs, ge));
        }
        pos = ge;
    }
    out.extend_from_slice(&o[pos..]);
    Some(MergeOutcome { text: out.concat(), conflicts })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_overlapping_edits_are_both_kept() {
        let base = "标题\n第一段\n第二段\n第三段\n";
        let local = "标题\n第一段（本机修改）\n第二段\n第三段\n";
        let remote = "标题\n第一段\n第二段\n第三段（远端修改）\n新增结尾\n";
        let r = merge_text(base, local, remote, false).unwrap();
        assert_eq!(r.text, "标题\n第一段（本机修改）\n第二段\n第三段（远端修改）\n新增结尾\n");
        assert_eq!(r.conflicts, 0);
    }

    #[test]
    fn overlapping_edits_take_newer_side() {
        let base = "a\nb\nc\n";
        let local = "a\nB-local\nc\n";
        let remote = "a\nB-remote\nc\n";
        assert_eq!(merge_text(base, local, remote, true).unwrap().text, "a\nB-local\nc\n");
        let r = merge_text(base, local, remote, false).unwrap();
        assert_eq!(r.text, "a\nB-remote\nc\n");
        assert_eq!(r.conflicts, 1);
    }

    #[test]
    fn identical_edits_are_not_conflicts() {
        let base = "a\nb\n";
        let both = "a\nb2\n";
        let r = merge_text(base, both, both, true).unwrap();
        assert_eq!(r.text, both);
        assert_eq!(r.conflicts, 0);
    }

    #[test]
    fn deletion_and_insertion_elsewhere() {
        let base = "1\n2\n3\n4\n5\n";
        let local = "1\n3\n4\n5\n"; // 删除第 2 行
        let remote = "1\n2\n3\n4\n5\n6\n"; // 末尾追加
        let r = merge_text(base, local, remote, true).unwrap();
        assert_eq!(r.text, "1\n3\n4\n5\n6\n");
    }

    #[test]
    fn insertions_at_same_point_prefer_newer() {
        let base = "a\nz\n";
        let local = "a\nL\nz\n";
        let remote = "a\nR\nz\n";
        assert_eq!(merge_text(base, local, remote, false).unwrap().text, "a\nR\nz\n");
    }

    #[test]
    fn last_line_without_newline() {
        let base = "x\ny";
        let local = "x2\ny";
        let remote = "x\ny\nz";
        let r = merge_text(base, local, remote, true).unwrap();
        assert_eq!(r.text, "x2\ny\nz");
    }

    #[test]
    fn myers_finds_lcs() {
        let a = ["a", "b", "c", "a", "b", "b", "a"];
        let b = ["c", "b", "a", "b", "a", "c"];
        let pairs = myers(&a, &b, 100).unwrap();
        // 经典示例 LCS 长度为 4
        assert_eq!(pairs.len(), 4);
        for w in pairs.windows(2) {
            assert!(w[0].0 < w[1].0 && w[0].1 < w[1].1);
        }
        for (x, y) in pairs {
            assert_eq!(a[x], b[y]);
        }
    }

    #[test]
    fn empty_inputs() {
        assert_eq!(merge_text("", "a\n", "", true).unwrap().text, "a\n");
        // 本机删除了 a、远端在其后追加 b：两处改动互不重叠，均保留
        assert_eq!(merge_text("a\n", "", "a\nb\n", true).unwrap().text, "b\n");
    }
}
