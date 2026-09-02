// CSV 导出：单据台账 → CSV（UTF-8 BOM，Excel 直接打开不乱码）
// 列对应用户的发票台账 Excel 模板，可直接交付税师或做线下核对

import { db } from './db.js';

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

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const HEADER = [
  '单据类型', '供应商', '单据号', '单据日期', '到期付款日', '付款状态', '付款日期', '付款方式',
  '净额EUR', '税率', '税额EUR', '含税总额EUR', '摘要', '成本中心', '对方IBAN', '存档位置', '备注',
];

export function docToRow(d, supplierName) {
  return [
    d.type, supplierName || '', d.docNumber || '', d.docDate || '', d.dueDate || '',
    d.payStatus || '', d.payDate || '', d.payMethod || '',
    d.netAmount ?? '', d.taxRate == null ? '' : (d.taxRate * 100).toFixed(0) + '%',
    d.taxAmount ?? '', d.grossAmount ?? '',
    d.summary || '', d.costCenter || '', d.counterpartyIban || '', d.archiveNote || '', d.note || '',
  ];
}

// 导出全部单据（或按筛选结果 rows 传入）
export async function exportDocumentsCsv(rows = null) {
  const docs = rows || await db.documents.toArray();
  const names = {};
  for (const s of await db.suppliers.toArray()) names[s.id] = s.name;
  const sorted = [...docs].sort((a, b) => (a.docDate || '').localeCompare(b.docDate || ''));
  const lines = [HEADER.join(',')];
  for (const d of sorted) {
    lines.push(docToRow(d, names[d.supplierId]).map(csvEscape).join(','));
  }
  const stamp = new Date().toISOString().slice(0, 10);
  download(`应付台账_${stamp}.csv`, '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}
