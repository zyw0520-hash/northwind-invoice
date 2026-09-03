// 轻量断言自测：models / sentinels / sync / backup / db / csv / pdfParse 纯函数
// 模块导入时自动执行并 console.log；设置页可重新运行（runSelftest）
// 浏览器控制台：import('./js/tests/selftest.js').then(m => m.runSelftest())

import { round2, parseDeNumber, fmtEur, calcTax, calcGross, computeAmounts, splitGross, daysBetween, addDays, computeDueDate, nameMatches, findSupplierByName } from '../models.js';
import { leadAlerts, deliveryAlerts, median, invoiceGaps, supplierGap, supplierGapAlerts, findDuplicate, dueClass, amountMismatch, buildWorkbench } from '../sentinels.js';
import { parseUid, remoteWins, tombstoneWins } from '../sync.js';
import { needsDailySnapshot, pruneSnapshots, SNAP_KEEP } from '../backup.js';
import { pickKeep } from '../db.js';
import { csvEscape } from '../csv.js';
import { parseDeDate, parseInvoiceText, inferDocType } from '../pdfParse.js';

export function runSelftest() {
  const results = [];
  function t(name, fn) {
    try { fn(); results.push({ ok: true, name }); }
    catch (e) { results.push({ ok: false, name: `${name} — ${e.message}` }); }
  }
  function eq(actual, expected, msg = '') {
    const norm = v => (Array.isArray(v) ? JSON.stringify(v) : v);
    if (norm(actual) !== norm(expected)) {
      throw new Error(`期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)} ${msg}`);
    }
  }
  const T = '2026-09-01'; // 固定"今天"，测试可复现

  // ---------- models ----------
  t('round2 规避浮点误差', () => eq(round2(0.1 + 0.2), 0.3));
  t('round2 税额计算', () => eq(round2(1045.17 * 0.19), 198.58));
  t('parseDeNumber 德式千分位', () => eq(parseDeNumber('1.234,56'), 1234.56));
  t('parseDeNumber 带欧元符', () => eq(parseDeNumber('€ 2.325,77'), 2325.77));
  t('parseDeNumber 普通小数点', () => eq(parseDeNumber('1234.56'), 1234.56));
  t('parseDeNumber 三位小数点为千分位', () => eq(parseDeNumber('1.234'), 1234));
  t('parseDeNumber 空值返回 null', () => eq(parseDeNumber(''), null));
  t('fmtEur 千分位', () => eq(fmtEur(10799.25), '€10.799,25'));
  t('calcTax 免税率返回 null', () => eq(calcTax(100, null), null));
  t('calcGross 净额+税额', () => eq(calcGross(297.14, 54.77), 351.91));
  t('computeAmounts 19%', () => {
    const a = computeAmounts(100, 0.19);
    eq(a.taxAmount, 19); eq(a.grossAmount, 119);
  });
  t('splitGross 由总额反推', () => {
    const s = splitGross(119, 0.19);
    eq(s.netAmount, 100); eq(s.taxAmount, 19);
  });
  t('daysBetween 同日为 0', () => eq(daysBetween('2026-09-01', '2026-09-01'), 0));
  t('daysBetween 跨月', () => eq(daysBetween('2026-08-28', '2026-09-07'), 10));
  t('addDays 月末跨月', () => eq(addDays('2026-08-28', 10), '2026-09-07'));
  t('computeDueDate 无付款天数返回 null', () => eq(computeDueDate('2026-08-28', 0), null));
  t('computeDueDate 14 天', () => eq(computeDueDate('2026-08-28', 14), '2026-09-11'));
  t('nameMatches 标准名与别名', () => {
    const s = { name: 'Raiffeisen Weser-Elbe eG', aliases: ['Raiffeisen', 'WRE'] };
    eq(nameMatches(s, 'wre'), true);
    eq(nameMatches(s, 'Raiffeisen Weser-Elbe eG'), true);
    eq(nameMatches(s, 'Würth'), false);
  });
  t('findSupplierByName 别名命中', () => {
    const list = [{ id: 'a', name: 'Würth', aliases: ['Wuerth'] }];
    eq(findSupplierByName(list, 'wuerth')?.id, 'a');
  });

  // ---------- sentinels ----------
  t('leadAlerts 未到期不报', () => {
    const leads = [{ id: '1', status: '等票中', registeredDate: '2026-08-25' }];
    eq(leadAlerts(leads, '2026-09-07', 14).length, 0); // 13 天
    eq(leadAlerts(leads, '2026-09-08', 14).length, 1); // 恰好 14 天
  });
  t('leadAlerts 已销账不报', () => {
    const leads = [{ id: '1', status: '已销账', registeredDate: '2026-07-01' }];
    eq(leadAlerts(leads, T, 14).length, 0);
  });
  t('leadAlerts 按天数倒序', () => {
    const leads = [
      { id: 'a', status: '等票中', registeredDate: '2026-08-20' },
      { id: 'b', status: '等票中', registeredDate: '2026-08-10' },
    ];
    const r = leadAlerts(leads, T, 14);
    eq(r[0].lead.id, 'b'); eq(r[0].days, 22);
  });
  t('deliveryAlerts 已等发票不报', () => {
    const docs = [
      { id: 'd1', type: '送货单', docDate: '2026-08-01', docNumber: 'L1' },
      { id: 'i1', type: '发票', docDate: '2026-08-10', relatedDeliveryId: 'd1' },
      { id: 'd2', type: '送货单', docDate: '2026-08-01', docNumber: 'L2' },
    ];
    const r = deliveryAlerts(docs, T, 14);
    eq(r.length, 1); eq(r[0].doc.id, 'd2'); eq(r[0].days, 31);
  });
  t('deliveryAlerts 14 天内不报', () => {
    const docs = [{ id: 'd1', type: '送货单', docDate: '2026-08-20' }];
    eq(deliveryAlerts(docs, T, 14).length, 0);
    eq(deliveryAlerts(docs, '2026-09-03', 14).length, 1); // 恰好 14 天
  });
  t('median 奇偶', () => {
    eq(median([1, 2, 3]), 2);
    eq(median([1, 2, 3, 4]), 2.5);
    eq(median([]), null);
  });
  t('invoiceGaps 升序日期间隔', () => eq(invoiceGaps(['2026-08-01', '2026-08-13', '2026-08-19']), [12, 6]));
  t('supplierGap 历史不足不启用', () => {
    eq(supplierGap(['2026-07-01', '2026-07-13'], T), null); // 仅 2 张
  });
  t('supplierGap 超过中位数×1.5 报警', () => {
    // 间隔 12 天，最后一张 2026-08-01，距 9-01 已 31 天 > max(12*1.5=18, 21)=21
    const r = supplierGap(['2026-07-08', '2026-07-20', '2026-08-01'], T);
    if (!r) throw new Error('应报警');
    eq(r.since, 31); eq(r.limit, 21); eq(r.medianGap, 12);
  });
  t('supplierGap 间隔内不报', () => {
    const r = supplierGap(['2026-08-01', '2026-08-13', '2026-08-25'], T);
    eq(r, null); // 距最后一张 7 天
  });
  t('supplierGapAlerts 按超期天数排序', () => {
    const docs = [
      { id: '1', type: '发票', supplierId: 's1', docDate: '2026-07-01' },
      { id: '2', type: '发票', supplierId: 's1', docDate: '2026-07-13' },
      { id: '3', type: '发票', supplierId: 's1', docDate: '2026-07-25' },
      { id: '4', type: '发票', supplierId: 's2', docDate: '2026-08-01' },
      { id: '5', type: '发票', supplierId: 's2', docDate: '2026-08-13' },
      { id: '6', type: '发票', supplierId: 's2', docDate: '2026-08-25' },
    ];
    const sups = [{ id: 's1', name: 'A' }, { id: 's2', name: 'B' }];
    const r = supplierGapAlerts(docs, sups, T);
    eq(r.length, 1); // s2 距最后一张仅 7 天不报警；s1 距 8-25 已 38 天报警
    eq(r[0].supplier.id, 's1');
  });
  t('findDuplicate 同供应商同发票号', () => {
    const docs = [{ id: '1', type: '发票', supplierId: 's1', docNumber: '674675' }];
    eq(findDuplicate(docs, { type: '发票', supplierId: 's1', docNumber: ' 674675 ' })?.id, '1');
    eq(findDuplicate(docs, { type: '发票', supplierId: 's2', docNumber: '674675' }), null);
    eq(findDuplicate(docs, { type: '送货单', supplierId: 's1', docNumber: '674675' }), null);
    eq(findDuplicate(docs, { type: '发票', supplierId: 's1', docNumber: '674675' }, '1'), null); // 排除自身
  });
  t('dueClass 红黄灯', () => {
    eq(dueClass({ type: '发票', dueDate: '2026-08-27', payStatus: '未付' }, T), 'red');
    eq(dueClass({ type: '发票', dueDate: '2026-09-05', payStatus: '未付' }, T), 'yellow');
    eq(dueClass({ type: '发票', dueDate: '2026-09-05', payStatus: '已付' }, T), null);
    eq(dueClass({ type: '发票', dueDate: '2026-10-05', payStatus: '未付' }, T), null);
    eq(dueClass({ type: '送货单', dueDate: '2026-08-01', payStatus: '未付' }, T), null); // 送货单不参与
  });
  t('amountMismatch 差异超 5% 提示', () => {
    const m = amountMismatch({ grossAmount: 110 }, { grossAmount: 100 });
    if (!m) throw new Error('应提示');
    eq(m.diff, 0.1);
    eq(amountMismatch({ grossAmount: 103 }, { grossAmount: 100 }), null); // 3% 在容差内
    eq(amountMismatch({ grossAmount: null }, { grossAmount: 100 }), null); // 缺金额不比
  });
  t('buildWorkbench 计数与排序', () => {
    const docs = [
      { id: '1', type: '发票', supplierId: 's1', docNumber: 'A', docDate: '2026-08-01', dueDate: '2026-08-15', payStatus: '未付', summary: '' },
      { id: '2', type: '送货单', supplierId: 's1', docNumber: 'B', docDate: '2026-08-01', summary: '' },
    ];
    const leads = [{ id: 'l1', status: '等票中', registeredDate: '2026-08-01', orderedBy: 'Alex', description: '托盘' }];
    const sups = [{ id: 's1', name: 'Würth' }];
    const wb = buildWorkbench(docs, leads, sups, T, {}, { s1: 'Würth' });
    eq(wb.counts.overdue, 1);
    eq(wb.counts.deliveryPending, 1);
    eq(wb.counts.leadPending, 1);
    eq(wb.todos[0].level, 'red'); // 逾期排最前
    eq(wb.todos[0].title, 'Würth · A'); // 用名称而非 UUID
  });

  // ---------- sync ----------
  t('parseUid 解析表名与记录 id', () => {
    const p = parseUid('documents:abc-123');
    eq(p.tbl, 'documents'); eq(p.id, 'abc-123');
  });
  t('parseUid 非法返回 null', () => eq(parseUid('nocolon'), null));
  t('remoteWins 按 updatedAt 比较', () => {
    if (!remoteWins(null, { updatedAt: 1 })) throw new Error('本地缺失应取远端');
    eq(remoteWins({ updatedAt: 5 }, { updatedAt: 3 }), false);
    eq(remoteWins({ updatedAt: 2 }, { updatedAt: 3 }), true);
  });
  t('tombstoneWins 删除与复活', () => {
    eq(tombstoneWins(null, { deletedAt: 10 }), true);
    eq(tombstoneWins({ updatedAt: 5 }, { deletedAt: 10 }), true);
    eq(tombstoneWins({ updatedAt: 15 }, { deletedAt: 10 }), false); // 删除后又改过 → 复活
  });

  // ---------- backup / db / csv ----------
  t('needsDailySnapshot 按日判断', () => {
    eq(needsDailySnapshot('2026-08-31', '2026-09-01'), true);
    eq(needsDailySnapshot('2026-09-01', '2026-09-01'), false);
  });
  t(`pruneSnapshots 保留最新 ${SNAP_KEEP} 份`, () => {
    const list = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
    const { keep, remove } = pruneSnapshots(list, 7);
    eq(keep.length, 7); eq(keep[0].id, 10); eq(remove.length, 3); eq(remove[0].id, 3);
  });
  t('pickKeep 保留最早创建', () => {
    const rows = [
      { id: 'b', createdAt: 200 },
      { id: 'a', createdAt: 100 },
      { id: 'c', createdAt: null },
    ];
    eq(pickKeep(rows).id, 'a');
  });
  t('csvEscape 逗号引号换行', () => {
    eq(csvEscape('plain'), 'plain');
    eq(csvEscape('a,b'), '"a,b"');
    eq(csvEscape('say "hi"'), '"say ""hi"""');
    eq(csvEscape('l1\nl2'), '"l1\nl2"');
    eq(csvEscape(null), '');
  });

  // ---------- pdfParse ----------
  t('parseDeDate 德式/ISO/两位年', () => {
    eq(parseDeDate('21.08.2026'), '2026-08-21');
    eq(parseDeDate('2026-08-21'), '2026-08-21');
    eq(parseDeDate('3.9.26'), '2026-09-03');
    eq(parseDeDate('31.12.99'), '2099-12-31');
    eq(parseDeDate(''), null);
    eq(parseDeDate('13.13.2026'), null);
  });
  t('parseInvoiceText 标准德语发票', () => {
    const text = [
      'Raiffeisen Weser-Elbe eG',
      'Am Markt 1',
      '27404 Zeven',
      '',
      'Rechnungsnummer: 2026-08147',
      'Rechnungsdatum: 21.08.2026',
      'Faellig am: 20.09.2026',
      '',
      'Pos Beschreibung Menge Preis Gesamt',
      '1 Diesel 500 l 1,52 760,00',
      '',
      'Nettobetrag: 760,00 EUR',
      'Umsatzsteuer 19 % : 144,40 EUR',
      'Gesamtbetrag: 904,40 EUR',
      '',
      'IBAN: DE21 2405 0115 0001 2345 67',
      'Kostenstelle: WH-12',
    ].join('\n');
    const p = parseInvoiceText(text);
    eq(p.supplierName, 'Raiffeisen Weser-Elbe eG');
    eq(p.docNumber, '2026-08147');
    eq(p.docDate, '2026-08-21');
    eq(p.dueDate, '2026-09-20');
    eq(p.netAmount, 760);
    eq(p.taxRate, 0.19);
    eq(p.taxAmount, 144.4);
    eq(p.grossAmount, 904.4);
    eq(p.iban, 'DE21240501150001234567');
    eq(p.costCenter, 'WH-12');
    eq(inferDocType(text, p.docNumber), null);
  });
  t('parseInvoiceText 交叉推算与类型推断', () => {
    // 只有 Netto/MwSt 行、无 Gesamtbetrag → 总额由净额+税额推算
    const text = [
      'KHT Industriepartner GmbH',
      'Rechnungs-Nr. RE26/0565-HB',
      'Datum, 31.08.2026',
      'Zwischensumme: 9.075,00',
      'MwSt. 19,00 % 1.724,25',
      'Zahlbar innerhalb von 14 Tagen.',
    ].join('\n');
    const p = parseInvoiceText(text);
    eq(p.docNumber, 'RE26/0565-HB');
    eq(p.docDate, '2026-08-31');
    eq(p.dueDate, '2026-09-14');
    eq(p.netAmount, 9075);
    eq(p.taxRate, 0.19);
    eq(p.taxAmount, 1724.25);
    eq(p.grossAmount, 10799.25);
    eq(inferDocType('Lieferschein-Nr. L22618967\nDatum 20.08.2026', null), '送货单');
    eq(inferDocType('Rechnung mit Gutschrift-Hinweis', 'R1'), '贷项通知单');
  });
  t('parseInvoiceText 百分比不混入金额', () => {
    const p = parseInvoiceText('Netto 100,00\nUSt 7,70 % 7,70\nGesamtbetrag 107,70');
    eq(p.netAmount, 100);
    eq(p.taxRate, 0.077);
    eq(p.taxAmount, 7.7);
    eq(p.grossAmount, 107.7);
  });
  t('parseInvoiceText Bezeichnung摘要 + Zahlungsziel天数', () => {
    // 同行摘要 + Zahlungsziel 30 Tage → 日期推算
    const p = parseInvoiceText([
      'Hauptzollamt Hamburg',
      'Rechnungsdatum: 05.09.2026',
      'Bezeichnung: Zollgebuehr Import Anlage 08/2026',
      'Zahlungsziel: 30 Tage netto',
      'Gesamtbetrag: 250,00 EUR',
    ].join('\n'));
    eq(p.summary, 'Zollgebuehr Import Anlage 08/2026');
    eq(p.dueDate, '2026-10-05');
    // 摘要在下一行
    const p2 = parseInvoiceText('Bezeichnung:\nParkhausgebuehr Flughafen\nRechnungsdatum: 01.09.2026');
    eq(p2.summary, 'Parkhausgebuehr Flughafen');
    // 表格列头不误抓为摘要，但数据行货品描述兜底生效；'zahlbar innerhalb' 兼容
    const p3 = parseInvoiceText([
      'Pos Bezeichnung Menge Einzelpreis Gesamt',
      '1 Diesel 500 l 1,52 760,00',
      'Rechnungsdatum: 20.08.2026',
      'Zahlbar innerhalb von 14 Tagen ohne Abzug',
    ].join('\n'));
    eq(p3.summary, 'Diesel');
    eq(p3.dueDate, '2026-09-03');
  });
  t('parseInvoiceText 摘要兜底（Miete标签 / 明细表数据行）', () => {
    // Miete 标签行 → 'Miete August'
    eq(parseInvoiceText('Firma XY\nMiete : August\nRechnungsdatum: 01.09.2026').summary, 'Miete August');
    // Betreff → 取值本身
    eq(parseInvoiceText('Betreff: Wartung Gebäude 2026\nRechnungsdatum: 01.09.2026').summary, 'Wartung Gebäude 2026');
    // 明细表数据行 → 货号后描述，遇数字列停
    eq(parseInvoiceText('Bezeichnung Menge Einheit Preis\nSW08 Schrankwand 2 500,00\nNettobetrag: 500,00').summary, 'Schrankwand');
  });
  t('parseInvoiceText Machulez版式（单据号行vom日期+表头数值行）', () => {
    const p = parseInvoiceText([
      'Baumineralien',
      'Recyclingbaustoffe',
      'Machulez Transport GmbH · Neue Industriestraße 5 · 27472 Cuxhaven',
      'NORTHWIND GmbH Internet: www.machulez.de',
      'Telefon: 04721 7444-44',
      'Rechnung-Nr.: AR2621327 vom 31.08.2026',
      'Kunden-Nr. : 23441 Sachbearbeiter : Fabian Schildt',
      'Miete : August',
      'Artikel Nr. Bezeichnung / Text Menge Einheit E-Preis Betrag /EUR',
      'L1003 Absetzcontainer 3,0 m³ 1,000 Monat 25,000 25,00',
      'Nettobetrag MwSt. % MwSt.-Betrag Endbetrag /EUR',
      '90,00 19 % 17,10 107,10',
      'Zahlbar: 14 Tage netto Kasse (bis 14.09.2026) ohne Abzug',
      'IBAN: DE56241500010000141838',
      'SWIFT-BIC: BRLADE21CUX',
      'Ust-ID: DE115170857',
    ].join('\n'));
    eq(p.docNumber, 'AR2621327');
    eq(p.docDate, '2026-08-31');           // 单据号行 'vom 31.08.2026'
    eq(p.dueDate, '2026-09-14');           // Zahlbar (bis 14.09.2026)
    eq(p.netAmount, 90);                   // 表头行+数值行布局
    eq(p.taxRate, 0.19);
    eq(p.taxAmount, 17.1);
    eq(p.grossAmount, 107.1);
    eq(p.supplierName, 'Machulez Transport GmbH'); // 在 · 处截断地址
    eq(p.summary, 'Miete August');         // 摘要兜底①：Miete 标签行
    eq(p.iban, 'DE56241500010000141838');
  });

  return results;
}

const results = runSelftest();
const fails = results.filter(r => !r.ok);
console.log(
  fails.length
    ? `❌ 自测 ${results.length - fails.length}/${results.length} 通过\n` + fails.map(f => '  ✗ ' + f.name).join('\n')
    : `✅ 自测全部通过（${results.length} 项）`
);
