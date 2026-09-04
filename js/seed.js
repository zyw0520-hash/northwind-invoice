// 种子数据：用户整理的真实样例（仅空库生成，且在首次同步拉取之后调用）
// 作用：验证功能 + 当操作示范；多设备各自生成会导致重复，靠 dedupDocs 收敛

import { db, uid } from './db.js';

export async function seedIfEmpty() {
  if (await db.documents.count() > 0) return false;
  if (await db.suppliers.count() > 0) return false;
  if (await db.leads.count() > 0) return false;

  const now = Date.now();
  const s = {};
  const mkSupplier = (key, name, aliases, defaultPayDays, note = '') => {
    s[key] = { id: uid(), name, aliases, defaultPayDays, note, createdAt: now, updatedAt: now };
  };
  mkSupplier('raif', 'Raiffeisen Weser-Elbe eG', ['Raiffeisen', 'WRE'], 14);
  mkSupplier('wuerth', 'Würth', ['Wuerth'], 14);
  mkSupplier('luening', 'Lüning Paletten', [], 0);
  mkSupplier('kloska', 'Uwe Kloska GmbH', [], 14);
  mkSupplier('kht', 'KHT Industriepartner GmbH', ['KHT'], 30);
  mkSupplier('hza', 'HZA Hamburg 海关', ['Hamburg海关', 'Zoll'], 0, '关税/逾期费，主要银行账户扣款');
  mkSupplier('cux', 'Landkreis Cuxhaven', [], 0);
  mkSupplier('sixt', 'Sixt 租车', ['Sixt'], 0, '公司信用卡扣款，注意抬头');

  const suppliers = Object.values(s);

  // 送货单先建，发票通过 relatedDeliveryId 挂接
  const dWuerthOld = { id: uid(), type: '送货单', supplierId: s.wuerth.id, docNumber: '8164627116', docDate: '2026-08-18', netAmount: null, taxRate: null, taxAmount: null, grossAmount: null, dueDate: null, payStatus: '', summary: '扭力扳手套装', costCenter: '', archiveNote: 'Wuerth_Lieferschein_8164627116.pdf', createdAt: now, updatedAt: now };
  const dKloska = { id: uid(), type: '送货单', supplierId: s.kloska.id, docNumber: 'L22618967', docDate: '2026-08-20', netAmount: null, taxRate: null, taxAmount: null, grossAmount: null, dueDate: null, payStatus: '', summary: '管道刷等耗材到货', costCenter: '', archiveNote: '', createdAt: now, updatedAt: now };
  const dWuerthNew = { id: uid(), type: '送货单', supplierId: s.wuerth.id, docNumber: '8165642721', docDate: '2026-08-27', netAmount: null, taxRate: null, taxAmount: null, grossAmount: null, dueDate: null, payStatus: '', summary: '砂纸等耗材', costCenter: '', archiveNote: 'Wuerth_Lieferschein_8165642721.pdf', createdAt: now, updatedAt: now };
  const dLuening = { id: uid(), type: '送货单', supplierId: s.luening.id, docNumber: '02620863', docDate: '2026-08-17', netAmount: 1187.50, taxRate: 0.19, taxAmount: 225.63, grossAmount: 1413.13, dueDate: null, payStatus: '未提交付款申请', summary: '欧标托盘50个+框架100个', costCenter: '', archiveNote: 'LUENING251P_001650.pdf', createdAt: now, updatedAt: now };

  const documents = [
    // 1 Raiffeisen 柴油配送
    { id: uid(), type: '发票', supplierId: s.raif.id, docNumber: '674675', docDate: '2026-08-28', netAmount: 1045.17, taxRate: 0.19, taxAmount: 198.58, grossAmount: 1243.75, dueDate: '2026-09-07', payStatus: '未提交付款申请', payDate: null, payMethod: '', counterpartyIban: '', summary: 'Diesel 553L 配送', costCenter: '', archiveNote: 'Raiffeisen 674675 vom 28.08.2026.PDF', relatedDeliveryId: null, relatedLeadId: null, note: '采购单 67811', createdAt: now, updatedAt: now },
    // 2 Würth 扭力扳手（挂送货单）
    { id: uid(), type: '发票', supplierId: s.wuerth.id, docNumber: '6088047408', docDate: '2026-08-18', netAmount: 297.14, taxRate: 0.19, taxAmount: 54.77, grossAmount: 343.01, dueDate: '2026-09-07', payStatus: '未提交付款申请', payDate: null, payMethod: '银行转账', counterpartyIban: 'DE33 6005 0101 0002 0430 58', summary: '扭力扳手套装+运费', costCenter: '', archiveNote: 'Wuerth_Rechnung_6088047408_18_08_2026.PDF', relatedDeliveryId: dWuerthOld.id, relatedLeadId: null, note: '采购单 2276623193', createdAt: now, updatedAt: now },
    // 3 Raiffeisen 维修（待 Alex 确认）
    { id: uid(), type: '发票', supplierId: s.raif.id, docNumber: '674682', docDate: '2026-08-29', netAmount: 3301.00, taxRate: 0.19, taxAmount: 627.19, grossAmount: 3928.19, dueDate: null, payStatus: '未提交付款申请', payDate: null, payMethod: '', counterpartyIban: '', summary: '维修/轮胎更换等', costCenter: '', archiveNote: 'Raiffeisen 674682 vom 29.08.2026.PDF', relatedDeliveryId: null, relatedLeadId: null, note: '等Alex确认', createdAt: now, updatedAt: now },
    dLuening,
    // 5 Uwe Kloska 发票（挂送货单）
    { id: uid(), type: '发票', supplierId: s.kloska.id, docNumber: 'R22615092', docDate: '2026-08-25', netAmount: 702.88, taxRate: 0.19, taxAmount: 133.55, grossAmount: 836.43, dueDate: null, payStatus: '未提交付款申请', payDate: null, payMethod: '', counterpartyIban: '', summary: '管道刷等工具耗材', costCenter: '', archiveNote: 'R22615092.pdf', relatedDeliveryId: dKloska.id, relatedLeadId: null, note: '等Alex确认', createdAt: now, updatedAt: now },
    // 6 KHT 工业服务
    { id: uid(), type: '发票', supplierId: s.kht.id, docNumber: 'RE26/0565-HB', docDate: '2026-08-31', netAmount: 9075.00, taxRate: 0.19, taxAmount: 1724.25, grossAmount: 10799.25, dueDate: '2026-09-09', payStatus: '未提交付款申请', payDate: null, payMethod: '银行转账', counterpartyIban: 'DE68 2919 0024 0225 6835 00', summary: '工业服务/项目', costCenter: '', archiveNote: 'Rechnung RE26 0565-HB.PDF', relatedDeliveryId: null, relatedLeadId: null, note: '等Alex确认', createdAt: now, updatedAt: now },
    // 7 HZA 关税（已逾期示范）
    { id: uid(), type: '政府通知', supplierId: s.hza.id, docNumber: 'ATS-1111-M0028Y', docDate: '2026-08-13', netAmount: 2302.77, taxRate: null, taxAmount: 23.00, grossAmount: 2325.77, dueDate: '2026-08-27', payStatus: '已提交付款申请', payDate: null, payMethod: '银行转账', counterpartyIban: 'DE69 2000 0000 0020 0010 21', summary: '关税+逾期费', costCenter: '', archiveNote: '关税催缴.pdf', relatedDeliveryId: null, relatedLeadId: null, note: '关税催缴', createdAt: now, updatedAt: now },
    // 8 交通罚单
    { id: uid(), type: '其他', supplierId: s.cux.id, docNumber: '32.4-662603808', docDate: '2026-08-19', netAmount: 180.00, taxRate: null, taxAmount: 28.50, grossAmount: 208.50, dueDate: null, payStatus: '未提交付款申请', payDate: null, payMethod: '银行转账', counterpartyIban: 'DE79 292500000155000551', summary: '超速罚款 26km/h', costCenter: '', archiveNote: '朱一未超速罚单.pdf', relatedDeliveryId: null, relatedLeadId: null, note: '朱一未超速', createdAt: now, updatedAt: now },
    // 9 Sixt 租车（已付）
    { id: uid(), type: '其他', supplierId: s.sixt.id, docNumber: '1001020003349636', docDate: '2026-08-18', netAmount: null, taxRate: null, taxAmount: null, grossAmount: null, dueDate: null, payStatus: '已付款', payDate: '2026-08-18', payMethod: '信用卡', counterpartyIban: '', summary: '租车费用', costCenter: '', archiveNote: '', relatedDeliveryId: null, relatedLeadId: null, note: '需换公司抬头', createdAt: now, updatedAt: now },
    dWuerthOld, dKloska, dWuerthNew,
  ];

  const leads = [
    { id: uid(), orderedBy: 'Alex', supplierId: s.wuerth.id, description: '砂纸等耗材（送货单 8165642721）', estAmount: null, registeredDate: '2026-08-27', expectedDate: null, status: '等票中', resolvedDocId: null, createdAt: now, updatedAt: now },
    { id: uid(), orderedBy: '厂长', supplierId: null, description: '车间清洁用品一批', estAmount: 200, registeredDate: '2026-08-25', expectedDate: null, status: '等票中', resolvedDocId: null, createdAt: now, updatedAt: now },
  ];

  await db.transaction('rw', [db.suppliers, db.documents, db.leads], async () => {
    db.suppliers.bulkAdd(suppliers);
    db.documents.bulkAdd(documents);
    db.leads.bulkAdd(leads);
  });
  return true;
}

