// NoteBoard 同步密钥本机加密
// Windows：DPAPI（CryptProtectData）绑定当前 Windows 用户，配置文件被拷走也无法解密；
// Android：配置位于应用私有目录（其他应用不可读），仅做 Base64 封装避免明文直接出现。

use base64::{engine::general_purpose::STANDARD, Engine};

const DPAPI_PREFIX: &str = "dpapi:";
const PLAIN_PREFIX: &str = "b64:";

/// 加密密钥（空串保持为空，便于判断“未填写”）
pub fn protect(plain: &str) -> String {
    if plain.is_empty() {
        return String::new();
    }
    #[cfg(windows)]
    {
        if let Some(cipher) = dpapi::protect(plain.as_bytes()) {
            return format!("{}{}", DPAPI_PREFIX, STANDARD.encode(cipher));
        }
    }
    format!("{}{}", PLAIN_PREFIX, STANDARD.encode(plain.as_bytes()))
}

/// 解密密钥；无法解密（例如配置文件来自其他用户/电脑）时返回空串，界面上表现为需要重新填写
pub fn unprotect(stored: &str) -> String {
    if stored.is_empty() {
        return String::new();
    }
    if let Some(rest) = stored.strip_prefix(DPAPI_PREFIX) {
        #[cfg(windows)]
        {
            if let Ok(cipher) = STANDARD.decode(rest) {
                if let Some(plain) = dpapi::unprotect(&cipher) {
                    return String::from_utf8(plain).unwrap_or_default();
                }
            }
        }
        let _ = rest;
        return String::new();
    }
    if let Some(rest) = stored.strip_prefix(PLAIN_PREFIX) {
        return STANDARD
            .decode(rest)
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
    }
    // 兼容手工编辑配置时直接写入的明文
    stored.to_string()
}

#[cfg(windows)]
mod dpapi {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    /// 调用 DPAPI 加密
    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(&input, PCWSTR::null(), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output).ok()?;
            Some(take_blob(output))
        }
    }

    /// 调用 DPAPI 解密
    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output).ok()?;
            Some(take_blob(output))
        }
    }

    /// 拷贝系统分配的输出缓冲区并释放
    unsafe fn take_blob(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let bytes = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(blob.pbData as *mut core::ffi::c_void));
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_round_trip() {
        let stored = protect("p@ss 令牌");
        assert_ne!(stored, "p@ss 令牌");
        assert_eq!(unprotect(&stored), "p@ss 令牌");
        assert_eq!(protect(""), "");
        assert_eq!(unprotect(""), "");
    }
}
