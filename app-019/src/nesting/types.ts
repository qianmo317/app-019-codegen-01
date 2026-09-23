// 开料排料：数据模型
// 坐标系：板件左上角为 (0,0)，x 沿板长方向向右，y 沿板宽方向向下；单位 mm。
// 木纹方向沿「长」（x 方向）。工件 length 必须沿木纹摆放，width 垂直木纹。

/** 待加工件 */
export interface NestPart {
  id: string
  name: string
  length: number  // 沿木纹方向尺寸 mm
  width: number   // 垂直木纹方向尺寸 mm
  thickness: number // 板厚 mm（只能排到同厚度板上）
  qty: number
}

/** 市售整张板规格 */
export interface SheetSpec {
  id: string
  name: string
  length: number  // 沿木纹
  width: number
  thickness: number
}

/** 库存板来源 */
export type StockSource = 'opened' | 'uncut'

/** 手上已有的板：开过料的余料板（opened）优先用，其次是未开的整张（uncut） */
export interface StockSheet {
  id: string
  length: number
  width: number
  thickness: number
  source: StockSource
  label?: string
}

/** 排料参数（锯路 / 修边 / 木纹） */
export interface NestSettings {
  kerfMm: number       // 锯路宽度 mm（件与件之间的切缝）
  trimMm: number       // 单边修边量 mm，两侧都要留
  edgeTrimMm: number   // 整张板四周边缘修边 mm（新板常见 5~10mm 毛边）
  allowRotate: boolean // 是否允许把工件转 90°（转了会在结果中标出待确认）
  minRemnantMm: number // 余料短边 ≥ 此值才算「整块可留」
}

export const DEFAULT_SETTINGS: NestSettings = {
  kerfMm: 3,
  trimMm: 1,
  edgeTrimMm: 8,
  allowRotate: false,
  minRemnantMm: 100,
}

/** 常用市售板材规格（mm，1220×2440 即 4×8 尺） */
export const PRESET_SPECS: Omit<SheetSpec, 'id'>[] = [
  { name: '1220×2440 标准板（4×8 尺）', length: 2440, width: 1220, thickness: 18 },
  { name: '1220×2440 / 15mm', length: 2440, width: 1220, thickness: 15 },
  { name: '1220×2440 / 9mm', length: 2440, width: 1220, thickness: 9 },
  { name: '1220×2440 / 25mm', length: 2440, width: 1220, thickness: 25 },
  { name: '915×1830（3×6 尺）', length: 1830, width: 915, thickness: 18 },
]

/** 一件在某张板上的摆放结果 */
export interface Placement {
  partId: string
  name: string
  x: number
  y: number
  /** 在板上占据的顺纹/横纹尺寸（物理坐标） */
  alongLength: number  // x 方向占用长度
  alongWidth: number   // y 方向占用宽度
  rotated: boolean     // true = 工件相对木纹转了 90°，需人工确认
}

/** 可留余料（整块矩形，板内坐标） */
export interface Remnant {
  x: number
  y: number
  length: number // x 方向
  width: number  // y 方向
  area: number
}

/** 排料结果中的一张板 */
export interface ResultSheet {
  id: string
  no: number
  kind: 'stock' | 'new'
  source?: StockSource
  specId?: string
  specName: string
  length: number
  width: number
  thickness: number
  placements: Placement[]
  remnants: Remnant[]
  usedArea: number
  wasteArea: number
}

/** 摆不下的件，绝不静默丢弃 */
export interface UnplacedItem {
  partId: string
  name: string
  length: number
  width: number
  thickness: number
  qty: number
  reason: string
}

/** 需要人工确认的转木纹件 */
export interface RotatedItem {
  sheetId: string
  partId: string
  name: string
  qty: number
}

/** 采购清单行：按规格聚合 */
export interface PurchaseLine {
  specId: string
  specName: string
  length: number
  width: number
  thickness: number
  qty: number
}

export interface NestResult {
  sheets: ResultSheet[]
  unplaced: UnplacedItem[]
  purchase: PurchaseLine[]
  warnings: string[]
  /** 每种厚度统计：需要几张 / 新购几张 / 利用率 */
  stats: NestStat[]
}

export interface NestStat {
  thickness: number
  totalParts: number
  placedParts: number
  sheetCount: number
  newSheetCount: number
  utilization: number // 已用面积 /（库存板 + 新购板）面积
}

/** 一批排料任务（输入 + 结果快照） */
export interface NestBatch {
  id: string
  title: string
  parts: NestPart[]
  specs: SheetSpec[]
  stock: StockSheet[]
  settings: NestSettings
  result?: NestResult
  updatedAt: number
}
