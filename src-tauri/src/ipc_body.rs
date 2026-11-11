// IPC 二进制正文解析
// 前端 invoke 传入 Uint8Array 时，正常走自定义协议（ipc://localhost、http://ipc.localhost），正文为原始字节；
// 但以下情况会退回 postMessage 通道，Uint8Array 被序列化成 JSON 数字数组：
//   - 安卓始终使用 postMessage（系统 WebView 读不到自定义协议的请求体）；
//   - 桌面端自定义协议请求失败一次（如 CSP connect-src 未放行 ipc:）后，本次会话的所有调用都改走 postMessage。
// 两种正文都按字节读取，避免回退后报「数据格式无效」。

use tauri::ipc::InvokeBody;

/// 读取正文字节：原始字节直接复制，JSON 数字数组逐项转为字节；其它格式返回 None
pub fn body_bytes(body: &InvokeBody) -> Option<Vec<u8>> {
    match body {
        InvokeBody::Raw(bytes) => Some(bytes.clone()),
        InvokeBody::Json(serde_json::Value::Array(items)) => items
            .iter()
            .map(|item| item.as_u64().and_then(|value| u8::try_from(value).ok()))
            .collect(),
        InvokeBody::Json(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_body_is_copied() {
        assert_eq!(body_bytes(&InvokeBody::Raw(vec![1, 2, 3])), Some(vec![1, 2, 3]));
    }

    #[test]
    fn json_number_array_falls_back_to_bytes() {
        let body = InvokeBody::Json(serde_json::json!([0, 137, 255]));
        assert_eq!(body_bytes(&body), Some(vec![0, 137, 255]));
    }

    #[test]
    fn invalid_json_body_is_rejected() {
        assert_eq!(body_bytes(&InvokeBody::Json(serde_json::json!([1, 256]))), None);
        assert_eq!(body_bytes(&InvokeBody::Json(serde_json::json!([1, -1]))), None);
        assert_eq!(body_bytes(&InvokeBody::Json(serde_json::json!({ "data": [1] }))), None);
    }
}
