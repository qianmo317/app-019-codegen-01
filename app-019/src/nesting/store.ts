// 排料批次库：localStorage 持久化 + 示例数据 + 新批次工厂
import type { NestBatch, NestPart, SheetSpec, StockSheet, NestSettings } from './types'
import { DEFAULT_SETTINGS, PRESET_SPECS } from './types'

const KEY = 'wjb.nesting.v1'

export function loadBatches(): NestBatch[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as NestBatch[]) : []
  } catch {
    return []
  }
}

export function saveBatches(batches: NestBatch[]): void {
  localStorage.setItem(KEY, JSON.stringify(batches))
}

export function getBatch(id: string): NestBatch | undefined {
  return loadBatches().find((b) => b.id === id)
}

export function upsertBatch(batch: NestBatch): NestBatch[] {
  const batches = loadBatches()
  const i = batches.findIndex((b) => b.id === batch.id)
  if (i >= 0) batches[i] = batch
  else batches.unshift(batch)
  saveBatches(batches)
  return batches
}

export function deleteBatch(id: string): NestBatch[] {
  const batches = loadBatches().filter((b) => b.id !== id)
  saveBatches(batches)
  return batches
}

let seq = 0
export function newId(prefix = 'b'): string {
  seq += 1
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`
}

/** 默认整板规格：1220×2440 的 18/15/9mm 三种 */
export function defaultSpecs(): SheetSpec[] {
  return PRESET_SPECS.slice(0, 3).map((s) => ({ ...s, id: newId('s') }))
}

/** 新批次工厂：空白 + 默认规格参数 */
export function makeBatch(title = '未命名批次'): NestBatch {
  return {
    id: newId(),
    title,
    parts: [],
    specs: defaultSpecs(),
    stock: [],
    settings: { ...DEFAULT_SETTINGS },
    updatedAt: Date.now(),
  }
}

/** 内置示例：鞋柜一批件 + 一块上次开剩的板 */
export function makeSampleBatch(): NestBatch {
  const spec18: SheetSpec = { ...PRESET_SPECS[0], id: newId('s') }
  const parts: NestPart[] = [
    { id: newId('p'), name: '鞋柜侧板', length: 800, width: 320, thickness: 18, qty: 2 },
    { id: newId('p'), name: '鞋柜顶板', length: 600, width: 320, thickness: 18, qty: 1 },
    { id: newId('p'), name: '鞋柜底板', length: 600, width: 320, thickness: 18, qty: 1 },
    { id: newId('p'), name: '层板', length: 560, width: 300, thickness: 18, qty: 3 },
    { id: newId('p'), name: '背板', length: 800, width: 600, thickness: 9, qty: 1 },
    { id: newId('p'), name: '柜门', length: 760, width: 290, thickness: 18, qty: 2 },
  ]
  const stock: StockSheet[] = [
    { id: newId('k'), length: 1200, width: 600, thickness: 18, source: 'opened', label: '上次开剩的余料板' },
  ]
  return {
    id: newId(),
    title: '示例 · 鞋柜一批',
    parts,
    specs: [spec18, { ...PRESET_SPECS[2], id: newId('s') }],
    stock,
    settings: { ...DEFAULT_SETTINGS },
    updatedAt: Date.now(),
  }
}

/** 深拷贝（导入/复制批次用），并换新 id */
export function cloneBatch(b: NestBatch, newTitle?: string): NestBatch {
  const copy = JSON.parse(JSON.stringify(b)) as NestBatch
  copy.id = newId()
  if (newTitle) copy.title = newTitle
  copy.updatedAt = Date.now()
  return copy
}

export function sanitizeSettings(s: Partial<NestSettings> | undefined): NestSettings {
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) }
}
