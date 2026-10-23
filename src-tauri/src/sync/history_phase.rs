// NoteBoard 同步：文档历史阶段
//
// 主同步成功后、释放远端锁之前执行（历史记录为「跨设备同步」模式，或有待清理的远端历史时）：
//   1. 清理切出跨设备同步后遗留的远端本机目录（分批）
//   2. 封口闲置的合并窗口，把临时标识换成同步刚分配的正式文件 ID
//   3. 下载其他设备的历史目录：只取变化的索引与本机缺少的正文
//   4. 清理已被同步删除（墓碑超过保留期或已移出清单）的文档历史
//   5. 上传本机目录：变化的索引、缺少的正文；单轮文件数有上限，其余留到下一轮
// 本阶段任何失败只记为警告，不影响主同步结果；.nb-history 不进入主同步清单与整文件扫描。

use super::backend::{Backend, CommitBatch};
use super::config::SyncSettings;
use super::error::{SyncErrorKind, SyncResult};
use super::manifest::{manifest_path, Manifest};
use super::types::SyncReport;
use super::util::now_ms;
use crate::history::catalog::{self, Catalog};
use crate::history::config::Mode;
use crate::history::service::{service, Service};
use crate::history::space::{is_temp_id, SyncCtx};
use std::collections::HashSet;

/// 单轮上传的文件数上限（Gitee/GitCode 逐文件提交受接口频率限制）
const UPLOAD_BUDGET: usize = 60;
/// 单轮下载的文件数上限
const DOWNLOAD_BUDGET: usize = 300;
/// 墓碑出现多久后清理对应历史（给离线设备与误删恢复留出时间）
const TOMBSTONE_GRACE_MS: i64 = 7 * 24 * 3600 * 1000;

/// 执行历史阶段；失败写入报告的 errors（警告），不中断同步
pub async fn run(cfg: &SyncSettings, device_id: &str, backend: &mut Backend, report: &mut SyncReport) {
    let Some(svc) = service() else { return };
    run_with(svc, cfg, device_id, backend, report).await;
}

/// 使用指定的记录服务执行（测试为每台模拟设备注入独立实例）
pub async fn run_with(svc: &Service, cfg: &SyncSettings, device_id: &str, backend: &mut Backend, report: &mut SyncReport) {
    if let Err(e) = run_inner(svc, cfg, device_id, backend).await {
        log::warn!("[sync] 历史记录同步失败: {}", e.message);
        report.errors.push(format!("历史记录：{}", e.message));
    }
}

async fn run_inner(svc: &Service, cfg: &SyncSettings, device_id: &str, backend: &mut Backend) -> SyncResult<()> {
    let root = cfg.root_dir.trim().to_string();
    let remote = cfg.provider.identity();
    retire(svc, &root, &remote, device_id, backend).await?;
    if svc.config().mode != Mode::Sync {
        return Ok(());
    }
    let Some(ctx) = svc.sync_ctx() else { return Ok(()) };
    if ctx.remote != remote || super::util::pkey(&ctx.root.to_string_lossy()) != super::util::pkey(&root) {
        return Ok(());
    }
    let now = now_ms();
    svc.phase_prepare(&ctx, now);
    // Git 类后端：主同步已提交，刷新分支快照后再提交历史
    backend.begin().await?;
    let manifest = match backend.read(&manifest_path()).await? {
        Some(b) => Manifest::parse(&b).map_err(super::error::SyncError::server)?,
        None => return Ok(()),
    };
    download_others(svc, &ctx, &manifest, backend).await?;
    cleanup_deleted(svc, &ctx, &manifest, now);
    upload_own(svc, &ctx, backend).await
}

/// 下载其他设备的历史目录
async fn download_others(svc: &Service, ctx: &SyncCtx, manifest: &Manifest, backend: &mut Backend) -> SyncResult<()> {
    let mut budget = DOWNLOAD_BUDGET;
    for device in manifest.devices.keys() {
        if device == &ctx.me || ctx.device_store(device).is_none() || budget == 0 {
            continue;
        }
        let Some(bytes) = backend.read(&catalog::catalog_path(device)).await? else { continue };
        let Some(remote) = Catalog::parse(&bytes) else { continue };
        let cached = svc.cached_catalog(ctx, device);
        if cached == remote {
            continue;
        }
        let store = ctx.device_store(device).expect("checked");
        let plan = catalog::plan_download(&cached, &remote, |sha| store.has_blob(sha));
        let mut docs = Vec::new();
        let mut blobs = Vec::new();
        let mut complete = true;
        for sha in &plan.fetch_blobs {
            if budget == 0 {
                complete = false;
                break;
            }
            budget -= 1;
            if let Some(gz) = backend.read(&catalog::blob_path(device, sha)).await? {
                blobs.push((sha.clone(), gz));
            }
        }
        for id in &plan.fetch_docs {
            if budget == 0 {
                complete = false;
                break;
            }
            budget -= 1;
            if let Some(b) = backend.read(&catalog::index_path(device, id)).await? {
                // 索引内容须与目录记录一致，避免读到提交中途的旧文件
                if remote.docs.get(id).map(|d| d.idx == super::util::sha256_hex(&b)).unwrap_or(false) {
                    docs.push((id.clone(), b));
                } else {
                    complete = false;
                }
            }
        }
        // 未下载完整时不记录远端目录：下一轮继续补齐
        let recorded = if complete { remote.clone() } else { partial_catalog(&cached, &remote, &docs) };
        svc.phase_store_download(ctx, device, &docs, &blobs, &plan.drop_docs, &recorded).map_err(super::error::SyncError::local)?;
    }
    Ok(())
}

/// 部分下载后记录到本地的目录：只包含已经拿到最新索引的文档
fn partial_catalog(cached: &Catalog, remote: &Catalog, got: &[(String, Vec<u8>)]) -> Catalog {
    let mut out = cached.clone();
    let ids: HashSet<&String> = got.iter().map(|(id, _)| id).collect();
    for (id, doc) in &remote.docs {
        if ids.contains(id) {
            out.docs.insert(id.clone(), doc.clone());
        }
    }
    out.docs.retain(|id, _| remote.docs.contains_key(id));
    out
}

/// 已删除文档：墓碑超过宽限期、或清单中已无记录（墓碑已过期移除）
fn cleanup_deleted(svc: &Service, ctx: &SyncCtx, manifest: &Manifest, now: i64) {
    let mut dead: HashSet<String> = HashSet::new();
    for id in ctx.own().list_doc_ids() {
        if is_temp_id(&id) {
            continue;
        }
        let gone = match manifest.entries.get(&id) {
            None => true,
            Some(e) => e.deleted.is_some_and(|t| now - t > TOMBSTONE_GRACE_MS),
        };
        if gone {
            dead.insert(id);
        }
    }
    svc.phase_drop_docs(ctx, &dead);
}

/// 上传本机目录
async fn upload_own(svc: &Service, ctx: &SyncCtx, backend: &mut Backend) -> SyncResult<()> {
    let cat_path = catalog::catalog_path(&ctx.me);
    // 以远端实际目录为准（本机上传状态可能缺失，或其他途径改动过远端）
    let remote_cat = backend.read(&cat_path).await?.and_then(|b| Catalog::parse(&b));
    let prev = remote_cat.clone().unwrap_or_default();
    let (desired, bodies) = svc.phase_desired(ctx);
    let plan = catalog::plan_upload(&prev, &desired, UPLOAD_BUDGET);
    if plan.is_empty() && plan.next == prev {
        svc.save_uploaded(ctx, remote_cat.as_ref());
        return Ok(());
    }
    let mut puts: Vec<(String, Vec<u8>)> = Vec::new();
    for sha in &plan.put_blobs {
        match svc.phase_blob(ctx, sha) {
            Some(gz) => puts.push((catalog::blob_path(&ctx.me, sha), gz)),
            // 正文已被本地清理：本轮跳过（下一轮期望目录会随之变化）
            None => return Ok(()),
        }
    }
    for id in &plan.put_docs {
        if let Some(b) = bodies.get(id) {
            puts.push((catalog::index_path(&ctx.me, id), b.clone()));
        }
    }
    let mut deletes: Vec<String> = plan.delete_docs.iter().map(|id| catalog::index_path(&ctx.me, id)).collect();
    deletes.extend(plan.delete_blobs.iter().map(|sha| catalog::blob_path(&ctx.me, sha)));
    let mut next = plan.next.clone();
    next.updated_at = now_ms();
    let batch = CommitBatch {
        puts,
        deletes,
        manifest_path: cat_path,
        manifest: next.to_bytes(),
        base_rev: remote_cat.as_ref().map(|c| c.rev),
        message: format!("NoteBoard 历史记录（{}）", ctx.device_name),
    };
    match backend.commit(batch).await {
        Ok(()) => {
            svc.save_uploaded(ctx, Some(&next));
            Ok(())
        }
        // 远端目录在此期间被改动（本机在另一窗口同时同步等）：下一轮按远端状态重新计算
        Err(e) if e.kind == SyncErrorKind::Conflict => Ok(()),
        Err(e) => Err(e),
    }
}

/// 清理切出跨设备同步后遗留的远端本机目录
async fn retire(svc: &Service, root: &str, remote: &str, device_id: &str, backend: &mut Backend) -> SyncResult<()> {
    for item in svc.retire_items() {
        if super::util::pkey(item.root.trim()) != super::util::pkey(root) || item.remote != remote {
            continue;
        }
        let cat_path = catalog::catalog_path(device_id);
        let (ctx, uploaded) = svc.uploaded_for(&item.root, &item.remote, device_id);
        let current = backend.read(&cat_path).await?.and_then(|b| Catalog::parse(&b)).or(uploaded);
        let Some(current) = current else {
            svc.finish_retire(&item);
            svc.save_uploaded(&ctx, None);
            continue;
        };
        // 期望目录为空：按上传计划分批删除全部索引与正文
        let empty = Catalog { device_id: device_id.to_string(), ..Default::default() };
        let plan = catalog::plan_upload(&current, &empty, UPLOAD_BUDGET);
        backend.begin().await?;
        let mut deletes: Vec<String> = plan.delete_docs.iter().map(|id| catalog::index_path(device_id, id)).collect();
        deletes.extend(plan.delete_blobs.iter().map(|sha| catalog::blob_path(device_id, sha)));
        let done = plan.next.docs.is_empty() && plan.next.garbage.is_empty();
        if done {
            // 最后一轮：连同目录文件一起删除
            for rel in &deletes {
                backend.delete(rel, "NoteBoard 清理历史记录").await?;
            }
            backend.delete(&cat_path, "NoteBoard 清理历史记录").await?;
            svc.finish_retire(&item);
            svc.save_uploaded(&ctx, None);
        } else {
            let mut next = plan.next.clone();
            next.updated_at = now_ms();
            let batch = CommitBatch {
                puts: Vec::new(),
                deletes,
                manifest_path: cat_path,
                manifest: next.to_bytes(),
                base_rev: Some(current.rev),
                message: "NoteBoard 清理历史记录".into(),
            };
            match backend.commit(batch).await {
                Ok(()) => svc.save_uploaded(&ctx, Some(&next)),
                Err(e) if e.kind == SyncErrorKind::Conflict => {}
                Err(e) => return Err(e),
            }
        }
    }
    Ok(())
}
