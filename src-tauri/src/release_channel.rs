//! 发布渠道：GitHub 主仓库与腾讯云 CNB 镜像。
//! 检查更新、安装包、字体包与官方插件均按设置中的渠道选择下载来源；
//! 官方资源统一以 GitHub 下载地址登记，切换到 CNB 时只替换固定前缀，不接受任意外部地址。

/// GitHub Release 附件下载前缀
pub const GITHUB_DOWNLOAD_BASE: &str = "https://github.com/CrazyFigure/NoteBoard/releases/download/";
/// CNB 镜像 Release 附件下载前缀（由 GitHub Actions 同步，文件名与 tag 保持一致）
pub const CNB_DOWNLOAD_BASE: &str = "https://cnb.cool/crazy-figure/NoteBoard/-/releases/download/";

const GITHUB_REPO_URL: &str = "https://github.com/CrazyFigure/NoteBoard";
const CNB_REPO_URL: &str = "https://cnb.cool/crazy-figure/NoteBoard";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseChannel {
    Github,
    Cnb,
}

impl ReleaseChannel {
    /// 设置值只认 "cnb"，缺失或未知值一律回到默认 GitHub
    pub fn from_setting(value: &str) -> Self {
        if value.trim().eq_ignore_ascii_case("cnb") {
            Self::Cnb
        } else {
            Self::Github
        }
    }

    /// 每次网络操作前读取设置，切换渠道后无需重启即可生效
    pub fn current() -> Self {
        Self::from_setting(&crate::settings::model::load().system.update_channel)
    }

    /// 仓库主页
    pub fn repo_url(self) -> &'static str {
        match self {
            Self::Github => GITHUB_REPO_URL,
            Self::Cnb => CNB_REPO_URL,
        }
    }

    /// Release 列表接口；CNB 网页路由在 Accept JSON 时返回与 GitHub 同构的列表，无需令牌
    pub fn release_list_url(self, page_size: usize) -> String {
        match self {
            Self::Github => format!(
                "https://api.github.com/repos/CrazyFigure/NoteBoard/releases?per_page={page_size}"
            ),
            Self::Cnb => format!("{CNB_REPO_URL}/-/releases?page=1&page_size={page_size}"),
        }
    }

    /// Release 列表请求的 Accept 头
    pub fn release_list_accept(self) -> &'static str {
        match self {
            Self::Github => "application/vnd.github+json",
            Self::Cnb => "application/json",
        }
    }

    /// 单个版本的 Release 页面；CNB 接口不返回 html_url，按固定格式拼接
    pub fn release_page_url(self, tag: &str) -> String {
        match self {
            Self::Github => format!("{GITHUB_REPO_URL}/releases/tag/{tag}"),
            Self::Cnb => format!("{CNB_REPO_URL}/-/releases/tag/{tag}"),
        }
    }

    /// 把登记的 GitHub 附件地址换成当前渠道地址；非官方前缀原样返回，由调用方继续校验
    pub fn rewrite_download_url(self, github_url: &str) -> String {
        match (self, github_url.strip_prefix(GITHUB_DOWNLOAD_BASE)) {
            (Self::Cnb, Some(rest)) => format!("{CNB_DOWNLOAD_BASE}{rest}"),
            _ => github_url.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_setting_falls_back_to_github() {
        assert_eq!(ReleaseChannel::from_setting(""), ReleaseChannel::Github);
        assert_eq!(ReleaseChannel::from_setting("gitee"), ReleaseChannel::Github);
        assert_eq!(ReleaseChannel::from_setting("CNB"), ReleaseChannel::Cnb);
    }

    #[test]
    fn cnb_rewrites_only_official_download_prefix() {
        let font = format!("{GITHUB_DOWNLOAD_BASE}fonts-v1.0.0/NoteBoard-fontpack-core-v1.0.0.zip");
        assert_eq!(
            ReleaseChannel::Cnb.rewrite_download_url(&font),
            "https://cnb.cool/crazy-figure/NoteBoard/-/releases/download/fonts-v1.0.0/NoteBoard-fontpack-core-v1.0.0.zip"
        );
        assert_eq!(ReleaseChannel::Github.rewrite_download_url(&font), font);
        assert_eq!(ReleaseChannel::Cnb.rewrite_download_url("https://example.com/a.zip"), "https://example.com/a.zip");
    }

    #[test]
    fn cnb_release_urls_follow_mirror_layout() {
        assert_eq!(
            ReleaseChannel::Cnb.release_page_url("v0.7.2"),
            "https://cnb.cool/crazy-figure/NoteBoard/-/releases/tag/v0.7.2"
        );
        assert!(ReleaseChannel::Cnb.release_list_url(30).ends_with("/-/releases?page=1&page_size=30"));
    }
}
