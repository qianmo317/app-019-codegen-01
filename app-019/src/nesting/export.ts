// 导出：开料清单 CSV（可直接照单开料）+ 任务/结果 JSON
import { fmt01 } from '../lib/format'
import type { NestJob, NestResult } from './types'
import { UNPLACED_REASON_LABEL } from './types'

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function sheetArea(result: NestResult): number {
  return result.sheets.reduce((a, s) => a + s.width * s.length, 0)
}

/** 生成分段 CSV：采购汇总 → 每张板的摆放明细（含余料）→ 摆不下的件 */
export function buildCuttingCSV(job: NestJob, result: NestResult): string {
  const lines: string[] = []
  const push = (row: (string | number)[]) => lines.push(row.map(csvCell).join(','))

  push(['# 开料清单'])
  push(['说明', `件间距(锯路) ${job.options.kerf}mm；四周修边 ${job.options.trim}mm；旋转 90° 的件开料前必须人工确认木纹`])
  push([])

  push(['## 采购汇总（需要新买的市售整张）'])
  push(['规格名称', '宽(横纹)mm', '长(顺纹)mm', '厚mm', '张数'])
  if (result.purchases.length === 0) push(['（无需购板，库存够）'])
  else for (const p of result.purchases) push([p.name, p.width, p.length, p.thickness, p.count])
  push([])

  push(['## 每张板摆放明细'])
  push(['板号', '规格', '类型', '厚mm', '件名', '件序号', 'X(距左)mm', 'Y(距顶)mm', '宽mm', '长mm', '旋转90°'])
  for (const s of result.sheets) {
    const typeLabel = s.kind === 'remnant' ? '已有余料板' : '整张'
    if (s.placements.length === 0) {
      push([s.sheetNo, s.name, typeLabel, s.thickness, '（空）', '', '', '', '', '', ''])
    }
    for (const pl of s.placements) {
      push([
        s.sheetNo,
        s.name,
        typeLabel,
        s.thickness,
        pl.name,
        pl.qtyIndex,
        fmt01(pl.x),
        fmt01(pl.y),
        fmt01(pl.w),
        fmt01(pl.h),
        pl.rotated ? '是-待确认' : '否',
      ])
    }
    for (const r of s.remnants) {
      push([s.sheetNo, s.name, typeLabel, s.thickness, '余料', '', fmt01(r.x), fmt01(r.y), fmt01(r.w), fmt01(r.h), ''])
    }
  }
  push([])

  push(['## 摆不下的件（需另行处理，未计入开料）'])
  push(['件名', '厚mm', '数量', '原因'])
  if (result.unplaced.length === 0) push(['（全部摆下）'])
  else for (const u of result.unplaced) push([u.name, u.thickness, u.qty, UNPLACED_REASON_LABEL[u.reason]])
  push([])

  const totalArea = sheetArea(result)
  const used = result.sheets.reduce((a, s) => a + s.placements.reduce((z, p) => z + p.w * p.h, 0), 0)
  const rate = totalArea > 0 ? ((used / totalArea) * 100).toFixed(1) : '0.0'
  push(['## 汇总'])
  push(['用板总数', result.sheets.length, '其中新开市售整张', result.purchaseCount, '面积利用率%', rate])
  push(['旋转件数(待确认)', result.rotatedCount, '摆不下件数', result.unplaced.reduce((n, u) => n + u.qty, 0)])

  return '﻿' + lines.join('\n')
}

export function exportJobJSON(job: NestJob, result: NestResult): string {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), job, result }, null, 2)
}

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadCSV(job: NestJob, result: NestResult): void {
  download(`开料清单-${stamp()}.csv`, buildCuttingCSV(job, result), 'text/csv;charset=utf-8')
}

export function downloadJobJSON(job: NestJob, result: NestResult): void {
  download(`开料任务-${stamp()}.json`, exportJobJSON(job, result), 'application/json')
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}
