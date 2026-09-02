// 业务计算：税额、到期日推算、德语数字格式解析、日期工具（纯函数，selftest 覆盖）

// ---------- 数字 ----------

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// 德语金额格式 → 数字：'1.234,56' → 1234.56；'1234.56' → 1234.56；'1.234' → 1234（德式千分位）
export function parseDeNumber(s) {
  if (s == null) return null;
  if (typeof s === 'number') return isFinite(s) ? s : null;
  let t = String(s).trim().replace(/[€\s\u00a0]/g, '');
  if (!t) return null;
  const neg = t.startsWith('-');
  t = t.replace(/^-/, '');
  if (t.includes(',')) {
    // 德式：点千分位、逗号小数
    t = t.replace(/\./g, '').replace(',', '.');
  } else if (t.includes('.')) {
    // 逗号缺席：点号后恰 3 位且前方有数字 → 视为千分位，否则视为小数点
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  }
  const n = parseFloat(t);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

export function fmtEur(n) {
  if (n == null || n === '' || !isFinite(Number(n))) return '';
  return '€' + Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------- 税额 ----------

// 税率存储为小数（0.19 / 0.07 / 0 / null=免税或未知）
export function calcTax(netAmount, taxRate) {
  if (netAmount == null || taxRate == null) return null;
  return round2(netAmount * taxRate);
}

export function calcGross(netAmount, taxAmount) {
  if (netAmount == null) return null;
  return round2(netAmount + (taxAmount || 0));
}

// 净额 + 税率 → { taxAmount, grossAmount }（表单联动）
export function computeAmounts(netAmount, taxRate) {
  const taxAmount = calcTax(netAmount, taxRate);
  return { taxAmount, grossAmount: calcGross(netAmount, taxAmount) };
}

// 由含税总额反推净额与税额（只填总额时用）
export function splitGross(grossAmount, taxRate) {
  if (grossAmount == null || taxRate == null) return null;
  const net = round2(grossAmount / (1 + taxRate));
  return { netAmount: net, taxAmount: round2(grossAmount - net) };
}

// ---------- 日期 ----------

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// a、b 均为 'YYYY-MM-DD'；返回 a → b 的天数（b 在后为正）
export function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db_ = new Date(b + 'T00:00:00');
  if (isNaN(da) || isNaN(db_)) return null;
  return Math.round((db_ - da) / 86400000);
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return null;
  d.setDate(d.getDate() + n);
  return todayStr(d);
}

// 到期日推算：发票类按发票日期 + 供应商默认付款天数；无默认天数返回空（手填）
export function computeDueDate(docDate, payDays) {
  if (!docDate || !payDays || payDays <= 0) return null;
  return addDays(docDate, payDays);
}

// ---------- 供应商别名匹配 ----------

// 名称是否匹配供应商（标准名或任一别名，忽略大小写与空白）
export function nameMatches(supplier, name) {
  if (!supplier || !name) return false;
  const norm = s => String(s).trim().toLowerCase();
  if (norm(supplier.name) === norm(name)) return true;
  return (supplier.aliases || []).some(a => norm(a) === norm(name));
}

// 按名称找供应商（找不到返回 null）；供手动录入时快速匹配
export function findSupplierByName(suppliers, name) {
  return suppliers.find(s => nameMatches(s, name)) || null;
}
