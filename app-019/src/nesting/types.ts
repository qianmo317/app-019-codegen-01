// 开料排料领域模型：件（Part）→ 板材（Stock）→ 摆放结果（NestResult）

/** 待加工件。length 为顺木纹方向尺寸，width 为垂直木纹方向尺寸 */
export interface NestPart {
  id: string
  name: string
  length: number // mm，顺纹
  width: number  // mm，横纹
  thickness: number // mm
  qty: number
  allowRotate: boolean // 是否允许旋转 90°（旋转后木纹方向改变，结果中会标出待人工确认）
}

/** 可用板材。count = -1 表示市售规格、张数不限（需要几张买几张） */
export interface StockDef {
  id: string
  name: string
  width: number  // mm，板宽（横纹方向）
  length: number // mm，板长（顺纹方向）
  thickness: number // mm
  count: number // 可用张数；-1 = 无限（市售整张）
  kind: 'sheet' | 'remnant' // sheet=整张，remnant=已开过的余料板
}

export interface NestOptions {
  kerf: number // 件与件之间预留的锯路+修边宽度 mm
  trim: number // 每张板四周修边量 mm
  minRemnant: number // 余料短边不小于该值才算「可留整块余料」mm
}

export interface NestJob {
  parts: NestPart[]
  stocks: StockDef[]
  options: NestOptions
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 单件在板上的摆放位置（坐标相对板左上角，已含修边偏移） */
export interface Placement {
  partId: string
  name: string
  x: number
  y: number
  w: number // 实际占据宽（不含锯路）
  h: number // 实际占据长（不含锯路）
  rotated: boolean // true = 相对木纹转了 90°
  qtyIndex: number // 同名件的第几件
}

/** 一块已使用的板（新开的整张或已有的余料板实例） */
export interface UsedStock {
  stockId: string
  name: string
  kind: 'sheet' | 'remnant'
  width: number
  length: number
  thickness: number
  sheetNo: number
  placements: Placement[]
  remnants: Rect[] // 可留作整块的余料
}

export interface PurchaseItem {
  stockId: string
  name: string
  width: number
  length: number
  thickness: number
  count: number
}

export type UnplacedReason = 'no-stock' | 'stock-exhausted' | 'too-large'

export interface UnplacedItem {
  partId: string
  name: string
  thickness: number
  qty: number
  reason: UnplacedReason
}

export interface NestResult {
  sheets: UsedStock[]
  purchases: PurchaseItem[] // 需要购买的市售整张（按规格汇总）
  unplaced: UnplacedItem[] // 摆不下的件（绝不丢弃）
  warnings: string[] // 旋转确认等人审提示
  rotatedCount: number
  purchaseCount: number
  usableRemnantArea: number // mm²，集中在大块余料里的面积（越大越好）
}

export const UNPLACED_REASON_LABEL: Record<UnplacedReason, string> = {
  'no-stock': '没有该厚度的板材',
  'stock-exhausted': '现有板材张数用完',
  'too-large': '件比任何板都大（即使旋转）',
}
