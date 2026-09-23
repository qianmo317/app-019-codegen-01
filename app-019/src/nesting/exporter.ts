// 排料结果导出：CSV 开料清单（Excel 可开）/ TXT 打印开料单 / JSON 批次往返
import type { NestBatch, NestResult, ResultSheet } from './types'

/** 数字去尾零：1220.0 → 1220 */
function n(x: number): string {
  return Number.isInteger(x) ? String(x) : String(Math.round(x * 10) / 10)
}

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 开料清单 CSV：分「采购 / 摆放 / 余料 / 摆不下」四段，UTF-8 BOM 保证 Excel 中文不乱码 */
export function buildCSV(batch: NestBatch): string {
  const r: NestResult | undefined = batch.result
  const rows: (string | number)[][] = []
  rows.push(['# 开料清单', batch.title, `生成时间 ${new Date(batch.updatedAt).toLocaleString()}`])
  rows.push([
    `# 参数：锯路 ${n(batch.settings.kerfMm)}mm，单边修边 ${n(batch.settings.trimMm)}mm，板边修边 ${n(batch.settings.edgeTrimMm)}mm，允许旋转 ${batch.settings.allowRotate ? '是' : '否'}`,
  ])
  rows.push([])

  rows.push(['== 采购清单 =='])
  rows.push(['规格', '长(顺纹)mm', '宽mm', '厚mm', '数量(张)'])
  for (const p of r?.purchase ?? []) {
    rows.push([p.specName, n(p.length), n(p.width), n(p.thickness), p.qty])
  }
  rows.push(['合计张数', '', '', '', (r?.purchase ?? []).reduce((s, p) => s + p.qty, 0)])
  rows.push([])

  rows.push(['== 每张板摆放明细 =='])
  rows.push(['板号', '来源', '板规格', '厚mm', '工件', '成品长mm', '成品宽mm', '数量', 'X mm', 'Y mm', '木纹旋转90°'])
  for (const s of r?.sheets ?? []) {
    const sourceLabel = s.kind === 'new' ? '新购板' : s.source === 'opened' ? '已开余料板' : '库存整张'
    // 同名件在同一张板上聚合
    const groups = new Map<string, { qty: number; first: ResultSheet['placements'][number] }>()
    for (const p of s.placements) {
      const g = groups.get(p.partId + (p.rotated ? '|r' : ''))
      if (g) g.qty += 1
      else groups.set(p.partId + (p.rotated ? '|r' : ''), { qty: 1, first: p })
    }
    for (const g of groups.values()) {
      const p = g.first
      rows.push([
        `#${s.no}`,
        sourceLabel,
        `${s.specName} ${n(s.length)}×${n(s.width)}`,
        n(s.thickness),
        p.name,
        n(p.alongLength),
        n(p.alongWidth),
        g.qty,
        n(p.x),
        n(p.y),
        p.rotated ? '是（需确认）' : '否',
      ])
    }
  }
  rows.push([])

  rows.push(['== 可留整块余料 =='])
  rows.push(['所属板号', '长mm', '宽mm', '厚mm', '面积m²'])
  for (const s of r?.sheets ?? []) {
    for (const rem of s.remnants) {
      rows.push([`#${s.no}`, n(rem.length), n(rem.width), n(s.thickness), (rem.area / 1e6).toFixed(3)])
    }
  }
  rows.push([])

  rows.push(['== 摆不下的件（未计入采购，勿漏做） =='])
  rows.push(['工件', '长mm', '宽mm', '厚mm', '数量', '原因'])
  for (const u of r?.unplaced ?? []) {
    rows.push([u.name, n(u.length), n(u.width), n(u.thickness), u.qty, u.reason])
  }

  return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
}

/** 打印用纯文本开料单 */
export function buildTextReport(batch: NestBatch): string {
  const r = batch.result
  const L: string[] = []
  L.push(`开料单：${batch.title}`)
  L.push(`生成时间：${new Date(batch.updatedAt).toLocaleString()}`)
  L.push(
    `参数：锯路 ${n(batch.settings.kerfMm)}mm，单边修边 ${n(batch.settings.trimMm)}mm（件间距 ${n(
      batch.settings.kerfMm + 2 * batch.settings.trimMm,
    )}mm），板边修边 ${n(batch.settings.edgeTrimMm)}mm，允许旋转 90°：${batch.settings.allowRotate ? '是' : '否'}`,
  )
  L.push('='.repeat(64))

  if (!r) {
    L.push('（尚未排料）')
    return L.join('\n')
  }

  L.push('【一、采购】')
  if (r.purchase.length === 0) L.push('  无需新购，库存板已够用')
  for (const p of r.purchase) {
    L.push(`  ${p.specName}  ${n(p.length)}×${n(p.width)}×${n(p.thickness)}mm  × ${p.qty} 张`)
  }
  for (const st of r.stats) {
    L.push(
      `  厚度 ${n(st.thickness)}mm：共 ${st.totalParts} 件，排入 ${st.placedParts} 件，用板 ${st.sheetCount} 张（新购 ${st.newSheetCount} 张），面积利用率 ${(st.utilization * 100).toFixed(1)}%`,
    )
  }

  L.push('')
  L.push('【二、每张板摆了哪些件】')
  for (const s of r.sheets) {
    const sourceLabel = s.kind === 'new' ? '新购板' : s.source === 'opened' ? '已开余料板（优先消耗）' : '库存整张'
    L.push(`  #${s.no} [${sourceLabel}] ${s.specName} ${n(s.length)}×${n(s.width)}×${n(s.thickness)}mm`)
    const groups = new Map<string, { qty: number; first: ResultSheet['placements'][number] }>()
    for (const p of s.placements) {
      const key = p.partId + (p.rotated ? '|r' : '')
      const g = groups.get(key)
      if (g) g.qty += 1
      else groups.set(key, { qty: 1, first: p })
    }
    for (const g of groups.values()) {
      const p = g.first
      L.push(
        `      ${g.qty}× ${p.name}（成品 ${n(p.alongLength)}×${n(p.alongWidth)}mm，起锯位 X${n(p.x)} Y${n(p.y)}）${
          p.rotated ? '  ★木纹旋转90°，需确认' : ''
        }`,
      )
    }
    if (s.remnants.length > 0) {
      L.push(`    可留余料：${s.remnants.map((rem) => `${n(rem.length)}×${n(rem.width)}mm`).join('，')}`)
    }
  }

  L.push('')
  L.push('【三、摆不下的件（单独处理，勿漏做）】')
  if (r.unplaced.length === 0) L.push('  无')
  for (const u of r.unplaced) {
    L.push(`  ${u.qty}× ${u.name} ${n(u.length)}×${n(u.width)}×${n(u.thickness)}mm —— ${u.reason}`)
  }

  if (r.warnings.length > 0) {
    L.push('')
    L.push('【注意】')
    for (const w of r.warnings) L.push(`  · ${w}`)
  }
  return L.join('\n')
}

/** 批次 JSON（导出/导入往返一致） */
export function exportBatchJSON(batch: NestBatch): string {
  return JSON.stringify(batch, null, 2)
}

/** 导入校验：结构合法返回 NestBatch，否则抛错 */
export function importBatchJSON(text: string): NestBatch {
  const obj = JSON.parse(text) as Partial<NestBatch>
  if (!obj || typeof obj !== 'object') throw new Error('无效的 JSON')
  if (typeof obj.id !== 'string' || typeof obj.title !== 'string') throw new Error('缺少 id/title')
  if (!Array.isArray(obj.parts) || !Array.isArray(obj.specs) || !Array.isArray(obj.stock)) {
    throw new Error('缺少 parts/specs/stock 列表')
  }
  if (!obj.settings || typeof obj.settings.kerfMm !== 'number') throw new Error('缺少 settings 参数')
  return obj as NestBatch
}

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
