// 排料任务的 localStorage 持久化 + 市售板规格预设
import type { NestJob, NestPart, StockDef } from './types'

const KEY = 'wjb.nesting.v1'

export const DEFAULT_OPTIONS = { kerf: 3, trim: 10, minRemnant: 100 }

/** 常见市售整张（mm）。count=-1 表示按需购买 */
export const STOCK_PRESETS: Omit<StockDef, 'id' | 'count' | 'kind'>[] = [
  { name: '标准板 1220×2440', width: 1220, length: 2440, thickness: 18 },
  { name: '标准板 1220×2440', width: 1220, length: 2440, thickness: 9 },
  { name: '标准板 1220×2440', width: 1220, length: 2440, thickness: 25 },
  { name: '大板 1250×2500', width: 1250, length: 2500, thickness: 18 },
]

let seq = 0
export function newId(prefix = 'n'): string {
  seq++
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`
}

export function defaultStocks(): StockDef[] {
  return [
    { id: newId('s'), name: '标准板 1220×2440', width: 1220, length: 2440, thickness: 18, count: -1, kind: 'sheet' },
    { id: newId('s'), name: '标准板 1220×2440', width: 1220, length: 2440, thickness: 9, count: -1, kind: 'sheet' },
  ]
}

/** 示例：一个小柜（18mm 柜体 + 9mm 背板） */
export function sampleParts(): NestPart[] {
  const mk = (name: string, length: number, width: number, thickness: number, qty: number, allowRotate = false): NestPart => ({
    id: newId('t'),
    name,
    length,
    width,
    thickness,
    qty,
    allowRotate,
  })
  return [
    mk('侧板', 800, 400, 18, 2),
    mk('顶底板', 600, 400, 18, 2),
    mk('隔板', 764, 380, 18, 2),
    mk('背板', 764, 564, 9, 1, true),
  ]
}

export function defaultJob(): NestJob {
  return { parts: sampleParts(), stocks: defaultStocks(), options: { ...DEFAULT_OPTIONS } }
}

export function loadJob(): NestJob {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return defaultJob()
    const job = JSON.parse(raw) as NestJob
    if (!Array.isArray(job.parts) || !Array.isArray(job.stocks) || !job.options) return defaultJob()
    return job
  } catch {
    return defaultJob()
  }
}

export function saveJob(job: NestJob): void {
  localStorage.setItem(KEY, JSON.stringify(job))
}
