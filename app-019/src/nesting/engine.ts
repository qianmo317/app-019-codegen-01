// 排料引擎：断头切割（guillotine）+ 最佳适配，多策略择优
// 约束：
//  - 件只能摆在同厚度板上，各件不重叠，件间距 >= kerf，距板边 >= trim
//  - 默认顺纹摆放；allowRotate 才允许转 90°，旋转件在结果中标记待确认
//  - 优先使用已开过的板（kind=remnant），再用小面积规格，最后新开大整张
//  - 板张数有限（count）时用完即止；count=-1 的市售规格按需新开
//  - 摆不下的件按原因汇总到 unplaced，不悄悄丢弃
import type {
  NestJob,
  NestPart,
  NestResult,
  Placement,
  Rect,
  StockDef,
  UnplacedItem,
  UnplacedReason,
  UsedStock,
} from './types'

const EPS = 0.05 // mm，浮点容差

interface Cell extends Rect {}

interface OpenSheet {
  stock: StockDef
  sheetNo: number
  cells: Cell[] // 互不重叠的可用矩形（断头切割分区）
  placements: Placement[]
}

interface ExpandedPart {
  part: NestPart
  qtyIndex: number
  ew: number // 顺纹摆放时占位宽（含锯路）
  eh: number // 顺纹摆放时占位长（含锯路）
  thickness: number
}

interface Candidate {
  sheet: OpenSheet | null // null = 需要新开一张（newStock 给出规格）
  newStock: StockDef | null
  cell: Cell
  rotated: boolean
  w: number // 沿 x 占位（含锯路）
  h: number // 沿 y 占位（含锯路）
  openPenalty: number // 0=用已有板，1=新开板
  stockRank: number // 板规格优先级（余料 < 小整张 < 大整张）
}

type SortMode = 'longside' | 'area' | 'width'
type SplitMode = 'longL' | 'shortL' | 'balanced'

interface Strategy {
  sort: SortMode
  split: SplitMode
}

const STRATEGIES: Strategy[] = [
  { sort: 'longside', split: 'longL' },
  { sort: 'longside', split: 'shortL' },
  { sort: 'longside', split: 'balanced' },
  { sort: 'area', split: 'longL' },
  { sort: 'width', split: 'longL' },
  { sort: 'area', split: 'balanced' },
]

/** 板内可用区（扣除四周修边） */
function usableRect(s: { width: number; length: number }, trim: number): Rect {
  return { x: trim, y: trim, w: s.width - trim * 2, h: s.length - trim * 2 }
}

function stockRank(stock: StockDef): number {
  // 数字越小越优先：余料板最优先；整张里面积小的优先（省大的/难找的）
  if (stock.kind === 'remnant') return 0
  return 1_000_000 + stock.width * stock.length
}

/** 件能否放进某规格的可用区（顺纹，或允许旋转） */
function fits(ep: ExpandedPart, stock: StockDef, trim: number): boolean {
  const uw = stock.width - 2 * trim
  const uh = stock.length - 2 * trim
  const okNormal = ep.ew <= uw + EPS && ep.eh <= uh + EPS
  const okRotated = ep.part.allowRotate && ep.eh <= uw + EPS && ep.ew <= uh + EPS
  return okNormal || okRotated
}

/** 摆不下原因：无该厚度板 / 有板但件怎么都放不进 / 板张数用完 */
function reasonFor(ep: ExpandedPart, job: NestJob): UnplacedReason {
  const { trim } = job.options
  const stocks = job.stocks.filter((s) => Math.abs(s.thickness - ep.thickness) < EPS)
  if (stocks.length === 0) return 'no-stock'
  if (!stocks.some((s) => fits(ep, s, trim))) return 'too-large'
  return 'stock-exhausted'
}

/** 断头切分：把 cell 在放入 (w,h) 后切成右、上两个不相交余块。
 * split 模式决定如何避免右上区域重复归属。 */
function splitCell(cell: Cell, w: number, h: number, mode: SplitMode): Cell[] {
  const rightW = cell.w - w
  const topH = cell.h - h
  const out: Cell[] = []

  const push = (c: Cell) => {
    if (c.w > EPS && c.h > EPS) out.push({ x: c.x, y: c.y, w: c.w, h: c.h })
  }

  if (rightW <= EPS && topH <= EPS) return out

  if (rightW <= EPS) {
    push({ x: cell.x, y: cell.y + h, w: cell.w, h: topH })
    return out
  }
  if (topH <= EPS) {
    push({ x: cell.x + w, y: cell.y, w: rightW, h: cell.h })
    return out
  }

  if (mode === 'longL') {
    // ┌────┬─────────────┐
    // │ 件 │   右块(全高) │
    // ├────┴─────────────┤
    // │     上块(整宽)    │
    // └──────────────────┘
    push({ x: cell.x + w, y: cell.y, w: rightW, h: cell.h })
    push({ x: cell.x, y: cell.y + h, w: w, h: topH })
  } else if (mode === 'shortL') {
    // ┌────┬─────────────┐
    // │ 件 │    右块      │
    // ├────┴──────┬───────┤
    // │   上块(整宽)       │
    // └───────────────────┘
    push({ x: cell.x + w, y: cell.y, w: rightW, h: h })
    push({ x: cell.x, y: cell.y + h, w: cell.w, h: topH })
  } else {
    // 均衡：让较宽的余块吃下右上角，保留一个更方正的大块
    if (rightW >= topH) {
      push({ x: cell.x + w, y: cell.y, w: rightW, h: cell.h })
      push({ x: cell.x, y: cell.y + h, w: w, h: topH })
    } else {
      push({ x: cell.x + w, y: cell.y, w: rightW, h: h })
      push({ x: cell.x, y: cell.y + h, w: cell.w, h: topH })
    }
  }
  return out
}

function partsForSort(job: NestJob): ExpandedPart[] {
  const { kerf } = job.options
  const out: ExpandedPart[] = []
  for (const p of job.parts) {
    for (let i = 0; i < p.qty; i++) {
      out.push({ part: p, qtyIndex: i + 1, ew: p.width + kerf, eh: p.length + kerf, thickness: p.thickness })
    }
  }
  return out
}

function sortExpanded(list: ExpandedPart[], mode: SortMode): ExpandedPart[] {
  const key = (e: ExpandedPart): number => {
    if (mode === 'area') return e.part.width * e.part.length
    if (mode === 'width') return Math.max(e.part.width, e.part.length)
    return Math.max(e.part.width, e.part.length)
  }
  // 厚度降序（厚板规格少，先排）；同厚度按策略键降序；面积作次序键
  return [...list].sort((a, b) => {
    if (b.thickness !== a.thickness) return b.thickness - a.thickness
    const ka = key(a)
    const kb = key(b)
    if (kb !== ka) return kb - ka
    return b.part.width * b.part.length - a.part.width * a.part.length
  })
}

function runStrategy(job: NestJob, strategy: Strategy): NestResult {
  const { kerf, trim, minRemnant } = job.options
  const openSheets: OpenSheet[] = []
  const usedCount = new Map<string, number>() // 有限板已占用张数
  let nextSheetNo = 1

  // 同厚度可选板（厚度匹配且扣除修边后仍为正）
  const stocksFor = (thickness: number): StockDef[] =>
    job.stocks
      .filter((s) => Math.abs(s.thickness - thickness) < EPS && s.width - 2 * trim > EPS && s.length - 2 * trim > EPS)
      .sort((a, b) => stockRank(a) - stockRank(b))

  const canOpen = (s: StockDef): boolean => s.count < 0 || (usedCount.get(s.id) ?? 0) < s.count

  const openNew = (s: StockDef): OpenSheet => {
    usedCount.set(s.id, (usedCount.get(s.id) ?? 0) + 1)
    const sheet: OpenSheet = {
      stock: s,
      sheetNo: nextSheetNo++,
      cells: [usableRect(s, trim)],
      placements: [],
    }
    openSheets.push(sheet)
    return sheet
  }

  /** 在已有/新开板里找该件的最佳落点 */
  function findBest(ep: ExpandedPart): Candidate | null {
    const { part } = ep
    const options: { w: number; h: number; rotated: boolean }[] = [
      { w: ep.ew, h: ep.eh, rotated: false },
    ]
    if (part.allowRotate) options.push({ w: ep.eh, h: ep.ew, rotated: true })

    let best: Candidate | null = null
    const consider = (sheet: OpenSheet | null, newStock: StockDef | null, cell: Cell, openPenalty: number) => {
      const rank = stockRank(newStock ?? sheet!.stock)
      for (const o of options) {
        if (o.w <= cell.w + EPS && o.h <= cell.h + EPS) {
          const c: Candidate = {
            sheet,
            newStock,
            cell,
            rotated: o.rotated,
            w: o.w,
            h: o.h,
            openPenalty,
            stockRank: rank,
          }
          if (!best || betterCandidate(c, best)) best = c
        }
      }
    }

    // 1) 已开板优先
    for (const sheet of openSheets) {
      if (Math.abs(sheet.stock.thickness - part.thickness) >= EPS) continue
      for (const cell of sheet.cells) consider(sheet, null, cell, 0)
    }
    // 2) 还能开的规格（按优先级：余料 → 小整张 → 大整张）；只造虚拟候选，提交时才真正开板
    for (const s of stocksFor(part.thickness)) {
      if (!canOpen(s)) continue
      consider(null, s, usableRect(s, trim), 1)
    }
    return best
  }

  // 比较规则：优先不新开板 → 板规格优先级 → 不旋转 → 短边贴合（余料更整）→ 长边贴合
  function betterCandidate(a: Candidate, b: Candidate): boolean {
    const ta: number[] = [
      a.openPenalty,
      a.stockRank,
      a.rotated ? 1 : 0,
      Math.min(a.cell.w - a.w, a.cell.h - a.h),
      Math.max(a.cell.w - a.w, a.cell.h - a.h),
    ]
    const tb: number[] = [
      b.openPenalty,
      b.stockRank,
      b.rotated ? 1 : 0,
      Math.min(b.cell.w - b.w, b.cell.h - b.h),
      Math.max(b.cell.w - b.w, b.cell.h - b.h),
    ]
    for (let i = 0; i < ta.length; i++) {
      if (Math.abs(ta[i] - tb[i]) > EPS) return ta[i] < tb[i]
    }
    return false
  }

  const unplaced: UnplacedItem[] = []
  const reasonByPart = new Map<string, UnplacedReason>()

  const expanded = sortExpanded(partsForSort(job), strategy.sort)

  for (const ep of expanded) {
    const best = findBest(ep)
    if (!best) {
      reasonByPart.set(ep.part.id, reasonFor(ep, job))
      continue
    }

    // 虚拟候选是新板时，此刻才真正开板（cell 即该新板的完整可用区）
    let target: OpenSheet
    let targetCell = best.cell
    if (best.sheet) {
      target = best.sheet
    } else {
      target = openNew(best.newStock!)
      targetCell = target.cells[0]
    }

    const { w, h, rotated } = best
    const realW = rotated ? ep.part.length : ep.part.width
    const realH = rotated ? ep.part.width : ep.part.length
    target.placements.push({
      partId: ep.part.id,
      name: ep.part.name,
      x: Math.round(targetCell.x * 10) / 10,
      y: Math.round(targetCell.y * 10) / 10,
      w: realW,
      h: realH,
      rotated,
      qtyIndex: ep.qtyIndex,
    })

    // 用新切出的两个余块替换被占用的 cell
    const idx = target.cells.indexOf(targetCell)
    const pieces = splitCell(targetCell, w, h, strategy.split)
    if (idx >= 0) target.cells.splice(idx, 1, ...pieces)
  }

  // 汇总摆不下的件（同名件若部分摆下，qty 按未摆下数量计）
  const placedCountByPart = new Map<string, number>()
  for (const sh of openSheets) {
    for (const pl of sh.placements) placedCountByPart.set(pl.partId, (placedCountByPart.get(pl.partId) ?? 0) + 1)
  }
  for (const p of job.parts) {
    const placed = placedCountByPart.get(p.id) ?? 0
    const missing = p.qty - placed
    if (missing > 0) {
      const ep: ExpandedPart = {
        part: p,
        qtyIndex: 1,
        ew: p.width + job.options.kerf,
        eh: p.length + job.options.kerf,
        thickness: p.thickness,
      }
      unplaced.push({
        partId: p.id,
        name: p.name,
        thickness: p.thickness,
        qty: missing,
        reason: reasonByPart.get(p.id) ?? reasonFor(ep, job),
      })
    }
  }

  // 组装已用板 + 余料统计
  const sheets: UsedStock[] = openSheets.map((sh) => {
    const remnants = sh.cells
      .filter((c) => {
        const rw = Math.max(0, c.w - kerf)
        const rh = Math.max(0, c.h - kerf)
        return rw >= minRemnant - EPS && rh >= minRemnant - EPS
      })
      .map((c) => ({
        x: Math.round(c.x * 10) / 10,
        y: Math.round(c.y * 10) / 10,
        w: Math.round(Math.max(0, c.w - kerf) * 10) / 10,
        h: Math.round(Math.max(0, c.h - kerf) * 10) / 10,
      }))
    return {
      stockId: sh.stock.id,
      name: sh.stock.name,
      kind: sh.stock.kind,
      width: sh.stock.width,
      length: sh.stock.length,
      thickness: sh.stock.thickness,
      sheetNo: sh.sheetNo,
      placements: sh.placements,
      remnants,
    }
  })

  // 购买汇总：只统计新开的市售整张（remnant 是已有库存，不用买）
  const purchaseMap = new Map<string, PurchaseAcc>()
  for (const sh of openSheets) {
    if (sh.stock.kind !== 'sheet') continue
    // count>=0 的有限整张视为已有库存（已购买），只有 -1 市售规格才计入采购
    if (sh.stock.count >= 0) continue
    const acc = purchaseMap.get(sh.stock.id)
    if (acc) acc.count++
    else
      purchaseMap.set(sh.stock.id, {
        stockId: sh.stock.id,
        name: sh.stock.name,
        width: sh.stock.width,
        length: sh.stock.length,
        thickness: sh.stock.thickness,
        count: 1,
      })
  }

  const rotatedCount = sheets.reduce((n, s) => n + s.placements.filter((p) => p.rotated).length, 0)
  const usableRemnantArea = sheets.reduce((sum, s) => sum + s.remnants.reduce((a, r) => a + r.w * r.h, 0), 0)
  const warnings: string[] = []
  if (rotatedCount > 0) {
    warnings.push(`有 ${rotatedCount} 件被旋转 90° 摆放（板图中用斜线标出），木纹方向已改变，开料前请逐件确认`)
  }

  return {
    sheets,
    purchases: [...purchaseMap.values()],
    unplaced,
    warnings,
    rotatedCount,
    purchaseCount: [...purchaseMap.values()].reduce((n, p) => n + p.count, 0),
    usableRemnantArea,
  }
}

interface PurchaseAcc {
  stockId: string
  name: string
  width: number
  length: number
  thickness: number
  count: number
}

/** 多策略择优：板数少 → 未摆下少 → 旋转少 → 可留余料总面积大 */
export function nest(job: NestJob): NestResult {
  const validParts = job.parts.filter((p) => p.qty > 0 && p.length > 0 && p.width > 0 && p.thickness > 0)
  const cleanJob: NestJob = { ...job, parts: validParts }

  let best: NestResult | null = null
  for (const strategy of STRATEGIES) {
    const r = runStrategy(cleanJob, strategy)
    if (!best || betterResult(r, best)) best = r
  }
  return best ?? runStrategy(cleanJob, STRATEGIES[0])
}

function betterResult(a: NestResult, b: NestResult): boolean {
  const ua = a.unplaced.reduce((n, u) => n + u.qty, 0)
  const ub = b.unplaced.reduce((n, u) => n + u.qty, 0)
  const key = (r: NestResult, un: number): number[] => [
    un,
    r.sheets.length,
    r.rotatedCount,
    -Math.round(r.usableRemnantArea),
  ]
  const ka = key(a, ua)
  const kb = key(b, ub)
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] < kb[i]
  }
  return false
}

/** 板上件的总面积（不含锯路），用于利用率展示 */
export function usedArea(result: NestResult): number {
  return result.sheets.reduce(
    (sum, s) => sum + s.placements.reduce((a, p) => a + p.w * p.h, 0),
    0,
  )
}

export type { Placement }
