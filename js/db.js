// 数据层：Dexie 表定义、CRUD 封装
// 主键为字符串 UUID（云同步要求全局唯一 id），禁止对 id 做 Number() 转换
// pdf 文件二进制存本地附属表 pdfFiles，不参与云同步（云端只存业务字段）

export const db = new Dexie('invoice-ledger');

db.version(1).stores({
  documents: 'id, type, supplierId, docDate, payStatus, dueDate, relatedDeliveryId, relatedLeadId',
  leads: 'id, status, supplierId, registeredDate',
  suppliers: 'id, name',
  settings: 'key',
  tombstones: 'uid, deletedAt',
  snapshots: '++id, day',
  pdfFiles: 'docId',
});

// ---------- UUID 与墓碑 ----------

export function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

export function makeTombstone(tbl, id) {
  return { uid: `${tbl}:${id}`, deletedAt: Date.now() };
}

function notifyWrite() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('ledger-write'));
}

// ---------- settings（key-value） ----------

export async function getSetting(key, fallback = null) {
  const row = await db.settings.get(key);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  await db.settings.put({ key, value });
}

// ---------- documents 应付单据 ----------

// 校验并规范化一条单据；非法字段抛错（系统边界校验：来自表单的用户输入）
export function validateDoc(d) {
  if (!['发票', '送货单', '贷项通知单', '关税通知', '罚单', '租车费', '其他'].includes(d.type)) {
    throw new Error('请选择单据类型');
  }
  if (!d.docDate || !/^\d{4}-\d{2}-\d{2}$/.test(d.docDate)) throw new Error('请填写单据日期');
  for (const k of ['netAmount', 'taxAmount', 'grossAmount']) {
    if (d[k] != null && (typeof d[k] !== 'number' || !isFinite(d[k]))) {
      throw new Error('金额必须为数字');
    }
  }
  if (d.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(d.dueDate)) throw new Error('到期日格式不正确');
  return d;
}

export async function addDocument(row, pdf = null) {
  validateDoc(row);
  const r = { ...row, id: uid(), createdAt: Date.now(), updatedAt: Date.now() };
  await db.transaction('rw', [db.documents, db.pdfFiles, db.leads], async () => {
    await db.documents.add(r);
    if (pdf) await db.pdfFiles.put({ docId: r.id, blob: pdf, name: pdf.name || '', addedAt: Date.now() });
    // 发票挂到线索 → 线索自动销账
    if (r.relatedLeadId) await resolveLeadInTx(r.relatedLeadId, r.id);
  });
  notifyWrite();
  return r.id;
}

export async function updateDocument(id, patch, pdf = null) {
  validateDoc({ ...patch });
  await db.transaction('rw', [db.documents, db.pdfFiles, db.leads], async () => {
    await db.documents.update(id, { ...patch, updatedAt: Date.now() });
    if (pdf) await db.pdfFiles.put({ docId: id, blob: pdf, name: pdf.name || '', addedAt: Date.now() });
    if (patch.relatedLeadId) await resolveLeadInTx(patch.relatedLeadId, id);
  });
  notifyWrite();
}

// 事务内销账：leads 表状态 → 已销账
async function resolveLeadInTx(leadId, docId) {
  const lead = await db.leads.get(leadId);
  if (lead && lead.status === '等票中') {
    await db.leads.update(leadId, { status: '已销账', resolvedDocId: docId, updatedAt: Date.now() });
  }
}

export async function deleteDocument(id) {
  const doc = await db.documents.get(id);
  await db.transaction('rw', [db.documents, db.pdfFiles, db.tombstones], async () => {
    await db.documents.delete(id);
    await db.pdfFiles.delete(id);
    await db.tombstones.put(makeTombstone('documents', id));
  });
  notifyWrite();
  return doc;
}

export async function getDocuments(filters = {}) {
  let rows = await db.documents.toArray();
  if (filters.type) rows = rows.filter(r => r.type === filters.type);
  if (filters.supplierId) rows = rows.filter(r => r.supplierId === filters.supplierId);
  if (filters.payStatus) rows = rows.filter(r => r.payStatus === filters.payStatus);
  if (filters.month) rows = rows.filter(r => (r.docDate || '').startsWith(filters.month));
  if (filters.keyword) {
    const kw = filters.keyword.trim().toLowerCase();
    if (kw) rows = rows.filter(r =>
      (r.docNumber || '').toLowerCase().includes(kw) ||
      (r.summary || '').toLowerCase().includes(kw) ||
      (r.archiveNote || '').toLowerCase().includes(kw));
  }
  rows.sort((a, b) => (b.docDate || '').localeCompare(a.docDate || '') || (b.createdAt || 0) - (a.createdAt || 0));
  return rows;
}

// ---------- leads 采购线索 ----------

export async function addLead(row) {
  const r = {
    ...row,
    status: row.status || '等票中',
    id: uid(), createdAt: Date.now(), updatedAt: Date.now(),
  };
  await db.leads.add(r);
  notifyWrite();
  return r.id;
}

export async function updateLead(id, patch) {
  await db.leads.update(id, { ...patch, updatedAt: Date.now() });
  notifyWrite();
}

export async function deleteLead(id) {
  await db.transaction('rw', [db.leads, db.documents, db.tombstones], async () => {
    // 引用该线索的单据解除关联
    const linked = await db.documents.where('relatedLeadId').equals(id).toArray();
    for (const d of linked) {
      await db.documents.update(d.id, { relatedLeadId: null, updatedAt: Date.now() });
    }
    await db.leads.delete(id);
    await db.tombstones.put(makeTombstone('leads', id));
  });
  notifyWrite();
}

export const getLeads = () => db.leads.toArray();

// ---------- suppliers 供应商 ----------

export async function addSupplier(row) {
  const r = { ...row, aliases: row.aliases || [], id: uid(), createdAt: Date.now(), updatedAt: Date.now() };
  await db.suppliers.add(r);
  notifyWrite();
  return r.id;
}

export async function updateSupplier(id, patch) {
  await db.suppliers.update(id, { ...patch, updatedAt: Date.now() });
  notifyWrite();
}

export async function deleteSupplier(id) {
  await db.transaction('rw', [db.suppliers, db.documents, db.leads, db.tombstones], async () => {
    // 引用该供应商的单据/线索解除关联（置空而非删除业务数据）
    const docs = await db.documents.where('supplierId').equals(id).toArray();
    for (const d of docs) await db.documents.update(d.id, { supplierId: null, updatedAt: Date.now() });
    const lds = await db.leads.where('supplierId').equals(id).toArray();
    for (const l of lds) await db.leads.update(l.id, { supplierId: null, updatedAt: Date.now() });
    await db.suppliers.delete(id);
    await db.tombstones.put(makeTombstone('suppliers', id));
  });
  notifyWrite();
}

export const getSuppliers = () => db.suppliers.toArray();

// 供应商显示名：按 id 查标准名（找不到时回退到 id 本身）
export async function supplierNameMap() {
  const map = {};
  for (const s of await db.suppliers.toArray()) map[s.id] = s.name;
  return map;
}

// ---------- 全量/清空（备份用） ----------

export async function dumpAll() {
  const [documents, leads, suppliers, settings] = await Promise.all([
    db.documents.toArray(), db.leads.toArray(), db.suppliers.toArray(), db.settings.toArray(),
  ]);
  return { documents, leads, suppliers, settings };
}

export async function clearAll() {
  await Promise.all([
    db.documents.clear(), db.leads.clear(), db.suppliers.clear(),
    db.settings.clear(), db.tombstones.clear(), db.pdfFiles.clear(),
  ]);
}

// ---------- 重复数据合并（多设备同步后按业务键收敛） ----------

// 纯函数：一组同 key 重复记录里保留哪条 —— 最早创建的；无 createdAt 时按 id 兜底
export function pickKeep(rows) {
  return [...rows].sort((a, b) =>
    (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity) ||
    String(a.id).localeCompare(String(b.id))
  )[0];
}

// 同供应商 + 单据号 + 类型 相同视为重复（种子多设备重复时收敛）
export async function dedupDocs() {
  let merged = 0;
  const docs = await db.documents.toArray();
  const groups = {};
  for (const d of docs) {
    const key = `${d.type}|${d.supplierId || ''}|${(d.docNumber || '').trim()}`;
    if (!d.docNumber) continue; // 无单据号不做重复收敛
    (groups[key] ??= []).push(d);
  }
  for (const group of Object.values(groups)) {
    if (group.length < 2) continue;
    const keep = pickKeep(group);
    for (const dup of group) {
      if (dup.id === keep.id) continue;
      await db.transaction('rw', [db.documents, db.pdfFiles, db.tombstones], async () => {
        await db.documents.delete(dup.id);
        await db.pdfFiles.delete(dup.id);
        await db.tombstones.put(makeTombstone('documents', dup.id));
      });
      merged++;
    }
  }
  if (merged) notifyWrite();
  return { merged };
}
