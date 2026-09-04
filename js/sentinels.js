// 防漏记机制：三哨兵 + 基础防护（纯函数，selftest 覆盖）
// 输入为已取出的数据数组与"今天"，不触库，便于测试

import { daysBetween } from './models.js';

// ---------- 哨兵1：采购线索催票 ----------

// 等票中线索超过 thresholdDays 天 → 需要催票
// 返回 [{ lead, days }]，按天数倒序
export function leadAlerts(leads, today, thresholdDays = 14) {
  const out = [];
  for (const lead of leads) {
    if (lead.status !== '等票中') continue;
    const days = daysBetween(lead.registeredDate, today);
    if (days == null || days < thresholdDays) continue;
    out.push({ lead, days });
  }
  out.sort((a, b) => b.days - a.days);
  return out;
}

// ---------- 哨兵2：送货单挂起等票 ----------

// 送货单后 thresholdDays 天仍无关联发票 → "票可能没来"
// invoiceByDelivery: Map(deliveryId → invoice)；relatedDeliveryId 反查
export function deliveryAlerts(documents, today, thresholdDays = 14) {
  const invoices = new Map();
  for (const d of documents) {
    if (d.type === '发票' && d.relatedDeliveryId) invoices.set(d.relatedDeliveryId, d);
  }
  const out = [];
  for (const d of documents) {
    if (d.type !== '送货单') continue;
    if (invoices.has(d.id)) continue;
    const days = daysBetween(d.docDate, today);
    if (days == null || days < thresholdDays) continue;
    out.push({ doc: d, days });
  }
  out.sort((a, b) => b.days - a.days);
  return out;
}

// ---------- 哨兵3：供应商开票周期画像 ----------

// 纯函数：中位数（偶数个取平均）
export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 纯函数：由升序发票日期数组计算间隔天数
export function invoiceGaps(datesAsc) {
  const gaps = [];
  for (let i = 1; i < datesAsc.length; i++) {
    const g = daysBetween(datesAsc[i - 1], datesAsc[i]);
    if (g != null && g >= 0) gaps.push(g);
  }
  return gaps;
}

// 单供应商可疑缺口：距上次开票 > 中位间隔 × mult 且 > minGapDays
// 历史发票 < minHistory 张不判定（数据不足）
export function supplierGap(invoiceDatesAsc, today, { mult = 1.5, minGapDays = 21, minHistory = 3 } = {}) {
  if (!invoiceDatesAsc || invoiceDatesAsc.length < minHistory) return null;
  const med = median(invoiceGaps(invoiceDatesAsc));
  if (med == null || med <= 0) return null;
  const since = daysBetween(invoiceDatesAsc[invoiceDatesAsc.length - 1], today);
  if (since == null) return null;
  const limit = Math.max(Math.round(med * mult), minGapDays);
  if (since <= limit) return null;
  return { since, medianGap: med, limit };
}

// 全量扫描：documents + suppliers → 可疑缺口列表
export function supplierGapAlerts(documents, suppliers, today, opts = {}) {
  const bySupplier = new Map();
  for (const d of documents) {
    if (d.type !== '发票' || !d.supplierId || !d.docDate) continue;
    if (!bySupplier.has(d.supplierId)) bySupplier.set(d.supplierId, []);
    bySupplier.get(d.supplierId).push(d.docDate);
  }
  const out = [];
  for (const s of suppliers) {
    const dates = bySupplier.get(s.id);
    if (!dates) continue;
    dates.sort();
    const gap = supplierGap(dates, today, opts);
    if (gap) out.push({ supplier: s, ...gap });
  }
  out.sort((a, b) => b.since - a.since);
  return out;
}

// ---------- 基础防护 ----------

// 发票号重复检测：同供应商 + 同单据号（同类型）已存在
export function findDuplicate(documents, { supplierId, docNumber, type }, excludeId = null) {
  if (!docNumber || !String(docNumber).trim()) return null;
  const num = String(docNumber).trim().toLowerCase();
  return documents.find(d =>
    d.id !== excludeId &&
    d.type === type &&
    String(d.docNumber || '').trim().toLowerCase() === num &&
    (supplierId ? d.supplierId === supplierId : true)
  ) || null;
}

// 到期红黄灯：'red' 已逾期未付 / 'yellow' 7 天内到期 / null
export function dueClass(doc, today, withinDays = 7) {
  if (doc.type !== '发票' && doc.type !== '政府通知') return null;
  if (!doc.dueDate || doc.payStatus === '已付款') return null;
  const days = daysBetween(today, doc.dueDate);
  if (days == null) return null;
  if (days < 0) return 'red';
  if (days <= withinDays) return 'yellow';
  return null;
}

// 金额差异提示：发票与所挂送货单总额差超 pct → 提示文案；任一方金额缺失返回 null
export function amountMismatch(invoice, delivery, pct = 0.05) {
  const a = invoice?.grossAmount, b = delivery?.grossAmount;
  if (a == null || b == null || b === 0) return null;
  const diff = Math.abs(a - b) / Math.abs(b);
  if (diff <= pct) return null;
  return { diff, message: `发票金额 €${a.toFixed(2)} 与送货单 €${b.toFixed(2)} 差异 ${(diff * 100).toFixed(1)}%（可能是运费或部分开票，请确认）` };
}

// ---------- 工作台聚合 ----------

// 汇总所有待办，按紧急度排序：逾期 > 挂起超期 > 催票 > 可疑缺口
export function buildWorkbench(documents, leads, suppliers, today, thresholds = {}, nameOf = {}) {
  const { leadDays = 14, deliveryDays = 14 } = thresholds;
  const overdue = [], pendingPay = [];
  for (const d of documents) {
    const cls = dueClass(d, today);
    if (cls === 'red') overdue.push(d);
    else if (cls === 'yellow') pendingPay.push(d);
  }
  const delivery = deliveryAlerts(documents, today, deliveryDays);
  const lead = leadAlerts(leads, today, leadDays);
  const gap = supplierGapAlerts(documents, suppliers, today);

  const todos = [
    ...overdue.map(d => ({
      level: 'red', icon: '🔴', kind: '逾期未付', days: -daysBetween(today, d.dueDate),
      title: `${nameOf[d.supplierId] || '未指定供应商'} · ${d.docNumber || '无单据号'}`,
      sub: `${d.type} ${d.summary || ''} 到期日 ${d.dueDate}`, doc: d,
    })),
    ...delivery.map(({ doc, days }) => ({
      level: 'orange', icon: '🟠', kind: '送货单等票', days,
      title: `${nameOf[doc.supplierId] || '未指定供应商'} · ${doc.docNumber || '无单据号'}`,
      sub: `送货单 ${doc.docDate} 已 ${days} 天未等到发票`, doc,
    })),
    ...lead.map(({ lead, days }) => ({
      level: 'yellow', icon: '🟡', kind: '线索催票', days,
      title: `${lead.orderedBy || '未记下单人'}：${lead.description || '（未记内容）'}`,
      sub: `登记于 ${lead.registeredDate}，已等票 ${days} 天`, lead,
    })),
    ...gap.map(({ supplier, since, medianGap, limit }) => ({
      level: 'purple', icon: '⚠️', kind: '可疑缺口', days: since,
      title: `${supplier.name} 已 ${since} 天没来发票`,
      sub: `历史开票间隔约 ${Math.round(medianGap)} 天，超过提醒线 ${limit} 天`, supplier,
    })),
  ].sort((a, b) => {
    const order = { red: 0, orange: 1, yellow: 2, purple: 3 };
    return order[a.level] - order[b.level] || b.days - a.days;
  });

  return {
    counts: {
      overdue: overdue.length,
      deliveryPending: delivery.length,
      leadPending: lead.length,
      supplierGap: gap.length,
      dueSoon: pendingPay.length,
    },
    todos,
  };
}
