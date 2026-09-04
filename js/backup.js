// 备份与快照：JSON 全量备份/导入恢复、每日本地快照（保留最近 7 份）
// CSV 导出见 csv.js

import { db, dumpAll, uid, setSetting } from './db.js';
import { syncAfterRestore } from './sync.js';

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function exportJson() {
  const data = await dumpAll();
  const payload = { version: 1, exportedAt: new Date().toISOString(), app: 'invoice-ledger', ...data };
  const stamp = new Date().toISOString().slice(0, 10);
  download(`应付台账备份_${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json');
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOC_TYPES = ['发票', '送货单', '政府通知', '其他'];

// 导入备份：校验失败抛错；通过后按 id 覆盖合并
export async function importJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文件');
  }
  if (!data || data.version !== 1 || data.app !== 'invoice-ledger') {
    throw new Error('文件不是本应用的备份（version 或 app 标识不符）');
  }
  for (const key of ['documents', 'leads', 'suppliers']) {
    if (!Array.isArray(data[key])) throw new Error(`备份缺少 ${key} 数据`);
  }
  const now = Date.now();
  const fixId = r => (typeof r.id === 'string' ? r.id : uid());
  const documents = data.documents.map(d => {
    if (!DOC_TYPES.includes(d.type) || !DATE_RE.test(d.docDate || '')) {
      throw new Error(`存在不合法的单据记录（id: ${d.id ?? '未知'}），已拒绝导入`);
    }
    return { ...d, id: fixId(d), updatedAt: d.updatedAt ?? now };
  });
  const leads = data.leads.map(l => ({ ...l, id: fixId(l), updatedAt: l.updatedAt ?? now }));
  const suppliers = data.suppliers.map(s => ({ ...s, id: fixId(s), updatedAt: s.updatedAt ?? now }));
  await db.transaction('rw', [db.documents, db.leads, db.suppliers, db.settings], () => {
    db.documents.bulkPut(documents);
    db.leads.bulkPut(leads);
    db.suppliers.bulkPut(suppliers);
    if (Array.isArray(data.settings)) db.settings.bulkPut(data.settings);
  });
  return { documents: documents.length, leads: leads.length, suppliers: suppliers.length };
}

// ---------- 本地快照 ----------

export const SNAP_KEEP = 7;

// 纯函数：今天是否还没有快照
export function needsDailySnapshot(lastDay, today) {
  return lastDay !== today;
}

// 纯函数：按 id 倒序保留最新 keep 份
export function pruneSnapshots(list, keep = SNAP_KEEP) {
  const sorted = [...list].sort((a, b) => b.id - a.id);
  return { keep: sorted.slice(0, keep), remove: sorted.slice(keep) };
}

const localDay = d => {
  const x = d ?? new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

// 拍快照（只含三张业务表，不含 settings）
export async function takeSnapshot(reason = 'manual') {
  const [documents, leads, suppliers] = await Promise.all([
    db.documents.toArray(), db.leads.toArray(), db.suppliers.toArray(),
  ]);
  const id = await db.snapshots.add({
    createdAt: Date.now(),
    day: localDay(),
    reason,
    counts: { documents: documents.length, leads: leads.length, suppliers: suppliers.length },
    data: JSON.stringify({ documents, leads, suppliers }),
  });
  const all = await db.snapshots.toArray();
  for (const s of pruneSnapshots(all).remove) await db.snapshots.delete(s.id);
  return id;
}

// 每日首次打开自动拍一份
export async function maybeDailySnapshot() {
  const last = await db.snapshots.orderBy('id').reverse().first();
  const today = localDay();
  if (last && !needsDailySnapshot(last.day, today)) return false;
  await takeSnapshot('daily');
  return true;
}

export async function exportSnapshot(id) {
  const snap = await db.snapshots.get(id);
  if (!snap) throw new Error('快照不存在');
  download(`应付台账快照_${snap.day}.json`, JSON.stringify({
    version: 1, exportedAt: new Date(snap.createdAt).toISOString(),
    app: 'invoice-ledger', ...JSON.parse(snap.data),
  }, null, 2), 'application/json');
}

// 恢复快照：覆盖当前业务数据（保留原 UUID），重置同步游标后 push-first 同步
export async function restoreSnapshot(id) {
  const snap = await db.snapshots.get(id);
  if (!snap) throw new Error('快照不存在');
  let data;
  try {
    data = JSON.parse(snap.data);
  } catch {
    throw new Error('快照数据损坏（JSON 解析失败）');
  }
  for (const key of ['documents', 'leads', 'suppliers']) {
    if (!Array.isArray(data[key])) throw new Error(`快照缺少 ${key} 数据`);
  }
  await db.transaction('rw', [db.documents, db.leads, db.suppliers, db.tombstones, db.pdfFiles], async () => {
    await Promise.all([
      db.documents.clear(), db.leads.clear(), db.suppliers.clear(),
      db.tombstones.clear(), db.pdfFiles.clear(), // 快照不含 PDF，一并清掉避免孤儿附件
    ]);
    db.documents.bulkPut(data.documents);
    db.leads.bulkPut(data.leads);
    db.suppliers.bulkPut(data.suppliers);
  });
  await setSetting('syncState', {});
  let sync = null;
  try {
    sync = await syncAfterRestore();
  } catch (e) {
    sync = { error: e.message };
  }
  return { counts: snap.counts, sync };
}
