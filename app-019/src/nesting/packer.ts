// 开料排料核心：断头台式（guillotine）二维装箱
//
// 为什么用 guillotine：板式家具开料锯（推台锯/电子锯）只能一刀走通，
// 递归断头台切分天然保证「排得下就能切」，且切分树的叶子互不重叠，
// 可直接作为整块余料上报。
//
// 锯路 + 修边怎么进算法（膨胀矩形法）：
//   件与件之间要留 gap = kerf + 2×trim（锯缝 + 两侧修边），新板四周边缘
//   再留 edgeTrim 毛边。若每件的包围盒在右侧/上侧各「膨胀」gap，再按
//   膨胀后的盒子紧密摆放，则：任意两件之间、以及件到可用区右/上边界
//   之间都恰好留出 gap；左/下侧的间距由前一件（或可用区原点）承担。
//   排完后自由矩形的物理尺寸 = 膨胀尺寸 − gap。
import type {
  NestPart,
  NestSettings,
  SheetSpec,
  StockSheet,
  NestResult,
  ResultSheet,
  Placement,
  Remnant,
  UnplacedItem,
  PurchaseLine,
  NestStat,
} from './types'

interface FreeRect {
  x: number
  y: number
  w: number // 含右侧 phantom gap
  h: number // 含上侧 phantom gap
}

interface UnitItem {
  partId: string
  name: string
  length: number
  width: number
  thickness: number
  seq: number
}

interface Bin {
  id: string
  kind: 'stock' | 'new'
  source?: StockSheet['source']
  specId?: string
  specName: string
  length: number
  width: number
  thickness: number
  margin: number
  placements: Placement[]
  free: FreeRect[]
  usedArea: number
  /** 开板先后序号（库存板为 0，新板按开板顺序递增） */
  openOrder: number
}

interface Candidate {
  freeIndex: number
  x: number
  y: number
  a: number // x 向占位（物理）
  b: number // y 向占位（物理）
  rotated: boolean
  s1: number // 最短富余
  s2: number // 最长富余
}

type ItemOrder = 'area' | 'maxside' | 'shortside' | 'crossgrain'
type SplitHeuristic = 'square' | 'shortaxis'
type SpecPick = 'smallest' | 'largest'
/** grain=同条件永远顺纹；compact=只按紧凑度（允许旋转以省板，由全局择优决定） */
type OrientMode = 'grain' | 'compact'

interface RunOutcome {
  bins: Bin[]
  unplaced: Map<string, UnplacedItem>
  rotatedUnits: number
  unplacedUnits: number
  newArea: number
  wasteArea: number
}

/** 校验并展开为单件列表；无效行进 warnings，不静默丢弃 */
export function validateParts(parts: NestPart[], warnings: string[]): UnitItem[] {
  const units: UnitItem[] = []
  parts.forEach((p, i) => {
    const row = `第 ${i + 1} 行「${p.name || '未命名'}」`
    if (!(p.length > 0) || !(p.width > 0) || !(p.thickness > 0)) {
      warnings.push(`${row}长宽厚必须为正数，已跳过`)
      return
    }
    if (!Number.isFinite(p.length + p.width + p.thickness)) {
      warnings.push(`${row}尺寸无效，已跳过`)
      return
    }
    if (!(p.qty > 0) || !Number.isInteger(p.qty)) {
      warnings.push(`${row}数量必须为正整数，已跳过`)
      return
    }
    for (let k = 0; k < p.qty; k++) {
      units.push({ partId: p.id, name: p.name || '未命名', length: p.length, width: p.width, thickness: p.thickness, seq: k })
    }
  })
  return units
}

function gapOf(s: NestSettings): number {
  return s.kerfMm + 2 * s.trimMm
}

function makeBin(
  length: number,
  width: number,
  thickness: number,
  margin: number,
  kind: Bin['kind'],
  openOrder: number,
  meta: { id: string; specName: string; source?: StockSheet['source']; specId?: string },
  gap: number,
): Bin {
  const innerW = length - 2 * margin
  const innerH = width - 2 * margin
  const free: FreeRect[] =
    innerW > 0 && innerH > 0
      ? [{ x: margin, y: margin, w: innerW + gap, h: innerH + gap }]
      : []
  return {
    id: meta.id,
    kind,
    source: meta.source,
    specId: meta.specId,
    specName: meta.specName,
    length,
    width,
    thickness,
    margin,
    placements: [],
    free,
    usedArea: 0,
    openOrder,
  }
}

/** 在一张板的自由矩形里找最佳站位；orient=grain 时同紧凑度优先顺纹，compact 时旋转可凭更紧凑胜出 */
function findCandidate(
  bin: Bin,
  item: UnitItem,
  allowRotate: boolean,
  gap: number,
  orient: OrientMode,
): Candidate | null {
  let best: Candidate | null = null
  const options: { a: number; b: number; rotated: boolean }[] = [{ a: item.length, b: item.width, rotated: false }]
  if (allowRotate && (item.length !== item.width)) options.push({ a: item.width, b: item.length, rotated: true })
  for (let fi = 0; fi < bin.free.length; fi++) {
    const f = bin.free[fi]
    for (const o of options) {
      const ew = o.a + gap
      const eh = o.b + gap
      if (f.w < ew - EPS || f.h < eh - EPS) continue
      const s1 = Math.min(f.w - ew, f.h - eh)
      const s2 = Math.max(f.w - ew, f.h - eh)
      const cand: Candidate = { freeIndex: fi, x: f.x, y: f.y, a: o.a, b: o.b, rotated: o.rotated, s1, s2 }
      if (!best || better(cand, best, orient)) best = cand
    }
  }
  return best
}

const EPS = 1e-6

function better(c: Candidate, b: Candidate, orient: OrientMode): boolean {
  if (orient === 'grain' && c.rotated !== b.rotated) return !c.rotated
  // BSSF：最短富余 → 最长富余
  if (Math.abs(c.s1 - b.s1) > EPS) return c.s1 < b.s1
  if (Math.abs(c.s2 - b.s2) > EPS) return c.s2 < b.s2
  if (c.rotated !== b.rotated) return !c.rotated
  if (Math.abs(c.x - b.x) > EPS) return c.x < b.x
  return c.y < b.y
}

/** 落位后按断头台切分自由矩形（两种切法由启发式决定） */
function splitFree(bin: Bin, cand: Candidate, heuristic: SplitHeuristic, gap: number): void {
  const f = bin.free[cand.freeIndex]
  const ew = cand.a + gap
  const eh = cand.b + gap
  const dw = f.w - ew // 右侧膨胀富余
  const dh = f.h - eh // 下侧膨胀富余

  let right: FreeRect | null
  let bottom: FreeRect | null
  if (heuristic === 'shortaxis') {
    // 经典切法：沿较窄富余方向走通刀
    if (dw < dh) {
      right = { x: f.x + ew, y: f.y, w: dw, h: f.h }
      bottom = { x: f.x, y: f.y + eh, w: ew, h: dh }
    } else {
      bottom = { x: f.x, y: f.y + eh, w: f.w, h: dh }
      right = { x: f.x + ew, y: f.y, w: dw, h: eh }
    }
  } else {
    // 保方：让切下来的小料短边尽量大（提高整块余料可留率）
    const vSmall = Math.min(ew, dh) // 竖切：左下块短边
    const hSmall = Math.min(dw, eh) // 横切：右上块短边
    if (vSmall >= hSmall) {
      right = { x: f.x + ew, y: f.y, w: dw, h: f.h }
      bottom = { x: f.x, y: f.y + eh, w: ew, h: dh }
    } else {
      bottom = { x: f.x, y: f.y + eh, w: f.w, h: dh }
      right = { x: f.x + ew, y: f.y, w: dw, h: eh }
    }
  }
  const next: FreeRect[] = []
  for (let i = 0; i < bin.free.length; i++) if (i !== cand.freeIndex) next.push(bin.free[i])
  if (right && right.w > EPS && right.h > EPS) next.push(right)
  if (bottom && bottom.w > EPS && bottom.h > EPS) next.push(bottom)
  // 删除被其他自由矩形完全包含的（断头台切分树本就互斥，这里再防御性清理）
  bin.free = next.filter((r, i) => !next.some((o, j) => j !== i && contains(o, r)))
}

function contains(outer: FreeRect, inner: FreeRect): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.w <= outer.x + outer.w + EPS &&
    inner.y + inner.h <= outer.y + outer.h + EPS
  )
}

// findCandidate 通过 gap 参数接收锯路间距

function orderUnits(units: UnitItem[], order: ItemOrder): UnitItem[] {
  const key = (u: UnitItem): number[] => {
    const area = u.length * u.width
    const maxSide = Math.max(u.length, u.width)
    const minSide = Math.min(u.length, u.width)
    switch (order) {
      case 'maxside':
        return [maxSide, area, u.length]
      case 'shortside':
        return [minSide, maxSide, area]
      case 'crossgrain':
        return [u.width, u.length, area]
      case 'area':
      default:
        return [area, maxSide, u.length]
    }
  }
  return [...units].sort((p, q) => {
    const kp = key(p)
    const kq = key(q)
    for (let i = 0; i < kp.length; i++) {
      if (Math.abs(kp[i] - kq[i]) > EPS) return kq[i] - kp[i]
    }
    return p.partId === q.partId ? p.seq - q.seq : p.partId < q.partId ? -1 : 1
  })
}

function pickSpec(
  specs: SheetSpec[],
  item: UnitItem,
  allowRotate: boolean,
  mode: SpecPick,
): SheetSpec | null {
  const fitsOriginal = specs.filter((s) => s.length >= item.length - EPS && s.width >= item.width - EPS)
  let pool = fitsOriginal
  if (pool.length === 0 && allowRotate) {
    pool = specs.filter((s) => s.length >= item.width - EPS && s.width >= item.length - EPS)
  }
  if (pool.length === 0) return null
  const sorted = [...pool].sort((a, b) => {
    const aa = a.length * a.width
    const bb = b.length * b.width
    if (mode === 'largest') {
      if (Math.abs(aa - bb) > EPS) return bb - aa
    } else if (Math.abs(aa - bb) > EPS) return aa - bb
    if (a.length !== b.length) return mode === 'largest' ? b.length - a.length : a.length - b.length
    return a.id < b.id ? -1 : 1
  })
  return sorted[0]
}

function oversizedReason(item: UnitItem, specs: SheetSpec[], allowRotate: boolean): string {
  const sameT = specs.filter((s) => s.thickness === item.thickness)
  if (sameT.length === 0) return `没有厚度 ${item.thickness}mm 的板材规格或库存板`
  const maxL = Math.max(...sameT.map((s) => s.length))
  const maxW = Math.max(...sameT.map((s) => s.width))
  if (item.length > maxL + EPS || item.width > maxW + EPS) {
    const rotatedFits = allowRotate || (item.width <= maxL + EPS && item.length <= maxW + EPS)
    if (item.length > maxL + EPS && rotatedFits && !allowRotate) {
      return `顺纹方向 ${item.length}mm 超长（最大 ${maxL}mm）：允许旋转 90° 后可排，但木纹方向会变，需确认`
    }
    return `成品 ${item.length}×${item.width}mm 超过可购最大板材 ${maxL}×${maxW}mm`
  }
  return '当前排料策略未能排入（可调整锯路/修边余量后重试）'
}

function runStrategy(
  units: UnitItem[],
  specs: SheetSpec[],
  stock: StockSheet[],
  settings: NestSettings,
  order: ItemOrder,
  split: SplitHeuristic,
  specPick: SpecPick,
  orient: OrientMode,
  idSeq: { n: number },
): RunOutcome {
  const gap = gapOf(settings)
  const bins: Bin[] = stock.map((st) =>
    makeBin(
      st.length,
      st.width,
      st.thickness,
      // 开过料的板边缘已是直边，不再吃毛边余量；未开的整张仍需修边
      st.source === 'opened' ? 0 : settings.edgeTrimMm,
      'stock',
      0,
      { id: `bin-stock-${st.id}`, specName: st.label || `库存板 ${st.length}×${st.width}`, source: st.source },
      gap,
    ),
  )
  const unplaced = new Map<string, UnplacedItem>()
  let rotatedUnits = 0
  let newOpenOrder = 1

  const addUnplaced = (item: UnitItem, reason: string) => {
    const ex = unplaced.get(item.partId)
    if (ex) ex.qty += 1
    else
      unplaced.set(item.partId, {
        partId: item.partId,
        name: item.name,
        length: item.length,
        width: item.width,
        thickness: item.thickness,
        qty: 1,
        reason,
      })
  }

  // 按厚度分组，组间互不混排；每组独立排序
  const groups = new Map<number, UnitItem[]>()
  for (const u of units) {
    const g = groups.get(u.thickness) ?? []
    g.push(u)
    groups.set(u.thickness, g)
  }

  for (const thickness of [...groups.keys()].sort((a, b) => a - b)) {
    const items = orderUnits(groups.get(thickness)!, order)
    const groupSpecs = specs.filter((s) => s.thickness === thickness)

    for (const item of items) {
      // 优先级：开过的板 → 未开的库存整张 → 本次新开的板；同级选 BSSF 最紧的
      const tiers: Bin[][] = [[], [], []]
      const cands: { bin: Bin; cand: Candidate }[] = []
      for (const bin of bins) {
        if (bin.thickness !== thickness) continue
        const cand = findCandidate(bin, item, settings.allowRotate, gap, orient)
        if (cand) cands.push({ bin, cand })
      }
      for (const c of cands) {
        if (c.bin.kind === 'new') tiers[2].push(c.bin)
        else if (c.bin.source === 'opened') tiers[0].push(c.bin)
        else tiers[1].push(c.bin)
      }
      let target: { bin: Bin; cand: Candidate } | null = null
      for (const tier of tiers) {
        if (tier.length === 0) continue
        let chosen: { bin: Bin; cand: Candidate } = cands.find((c) => c.bin === tier[0])!
        for (const b of tier.slice(1)) {
          const cur = cands.find((c) => c.bin === b)!
          if (better(cur.cand, chosen.cand, orient)) chosen = cur
        }
        target = chosen
        break
      }

      if (!target) {
        // 现有板都放不下 → 开一张新板（最小/最大适配规格）
        const spec = pickSpec(groupSpecs, item, settings.allowRotate, specPick)
        if (!spec) {
          addUnplaced(item, oversizedReason(item, groupSpecs, settings.allowRotate))
          continue
        }
        idSeq.n += 1
        const bin = makeBin(
          spec.length,
          spec.width,
          spec.thickness,
          settings.edgeTrimMm,
          'new',
          newOpenOrder++,
          { id: `bin-new-${idSeq.n}`, specName: spec.name, specId: spec.id },
          gap,
        )
        bins.push(bin)
        const cand = findCandidate(bin, item, settings.allowRotate, gap, orient)
        if (!cand) {
          // 理论上 pickSpec 已保证放得下；防御性兜底
          addUnplaced(item, oversizedReason(item, groupSpecs, settings.allowRotate))
          continue
        }
        target = { bin, cand }
      }

      const { bin, cand } = target
      bin.placements.push({
        partId: item.partId,
        name: item.name,
        x: cand.x,
        y: cand.y,
        alongLength: cand.a,
        alongWidth: cand.b,
        rotated: cand.rotated,
      })
      if (cand.rotated) rotatedUnits += 1
      bin.usedArea += cand.a * cand.b
      splitFree(bin, cand, split, gap)
    }
  }

  let newArea = 0
  let wasteArea = 0
  for (const b of bins) {
    if (b.placements.length === 0) continue
    if (b.kind === 'new') newArea += b.length * b.width
    const usable = (b.length - 2 * b.margin) * (b.width - 2 * b.margin)
    const remnantsArea = remnantRects(b, gap, settings.minRemnantMm).reduce((sum, r) => sum + r.area, 0)
    wasteArea += Math.max(0, usable - b.usedArea - remnantsArea)
  }

  return { bins, unplaced, rotatedUnits, unplacedUnits: [...unplaced.values()].reduce((s, u) => s + u.qty, 0), newArea, wasteArea }
}

/** 从自由矩形换算物理整块余料：幻影 gap 只在「外侧还有件」的方向扣除；贴可用区边缘的方向不扣 */
function remnantRects(
  bin: Bin,
  gap: number,
  minRemnant: number,
): { x: number; y: number; length: number; width: number; area: number }[] {
  const rightEdge = bin.length - bin.margin
  const bottomEdge = bin.width - bin.margin
  const out: { x: number; y: number; length: number; width: number; area: number }[] = []
  for (const f of bin.free) {
    const atRight = Math.abs(f.x + f.w - rightEdge) < EPS
    const atBottom = Math.abs(f.y + f.h - bottomEdge) < EPS
    const rl = Math.max(0, f.w - (atRight ? 0 : gap))
    const rw = Math.max(0, f.h - (atBottom ? 0 : gap))
    if (rl >= minRemnant - EPS && rw >= minRemnant - EPS) {
      out.push({ x: f.x, y: f.y, length: rl, width: rw, area: rl * rw })
    }
  }
  return out.sort((a, b) => b.area - a.area)
}

export interface PackInput {
  parts: NestPart[]
  specs: SheetSpec[]
  stock: StockSheet[]
  settings: NestSettings
}

/** 排料入口：16 组确定性策略择优（4 排序 × 2 切分 × 2 选规格），同输入必得同结果 */
export function pack(input: PackInput): NestResult {
  const { parts, specs, stock, settings } = input
  const warnings: string[] = []
  const units = validateParts(parts, warnings)
  const idSeq = { n: 0 }

  const orders: ItemOrder[] = ['area', 'maxside', 'shortside', 'crossgrain']
  const splits: SplitHeuristic[] = ['square', 'shortaxis']
  const picks: SpecPick[] = ['smallest', 'largest']
  // 允许旋转时两种朝向模式都跑：grain 同紧凑度永远顺纹；compact 允许旋转省板。
  // 全局按「摆不下数 → 新购面积 → 旋转件数 → 碎料」择优，故只有真省板才会采用旋转方案。
  const orients: OrientMode[] = settings.allowRotate ? ['grain', 'compact'] : ['grain']

  let best: RunOutcome | null = null
  let bestKey: number[] = []
  const scoreOf = (r: RunOutcome): number[] => [r.unplacedUnits, round9(r.newArea), r.rotatedUnits, round9(r.wasteArea)]
  const betterScore = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) > EPS) return a[i] < b[i]
    }
    return false
  }
  for (const orient of orients) {
    for (const order of orders) {
      for (const split of splits) {
        for (const pick of picks) {
          const r = runStrategy(units, specs, stock, settings, order, split, pick, orient, idSeq)
          // 越少摆不下 → 越少新购面积 → 越少转木纹 → 越少碎料（数值逐项比较，勿用字符串字典序）
          const key = scoreOf(r)
          if (!best || betterScore(key, bestKey)) {
            best = r
            bestKey = key
          }
        }
      }
    }
  }
  const chosen = best!

  // —— 组装结果 ——
  const usedBins = chosen.bins
    .filter((b) => b.placements.length > 0)
    .sort((a, b) => {
      const ta = a.kind === 'stock' ? (a.source === 'opened' ? 0 : 1) : 2
      const tb = b.kind === 'stock' ? (b.source === 'opened' ? 0 : 1) : 2
      if (ta !== tb) return ta - tb
      if (a.thickness !== b.thickness) return a.thickness - b.thickness
      return a.openOrder - b.openOrder
    })

  const sheets: ResultSheet[] = []
  const rotatedQtyByPart = new Map<string, number>()
  usedBins.forEach((b, i) => {
    const remnants: Remnant[] = remnantRects(b, gapOf(settings), settings.minRemnantMm).map((r) => ({
      x: r.x,
      y: r.y,
      length: r.length,
      width: r.width,
      area: r.area,
    }))
    const usable = (b.length - 2 * b.margin) * (b.width - 2 * b.margin)
    const remnantsArea = remnants.reduce((s, r) => s + r.area, 0)
    sheets.push({
      id: b.id,
      no: i + 1,
      kind: b.kind,
      source: b.source,
      specId: b.specId,
      specName: b.specName,
      length: b.length,
      width: b.width,
      thickness: b.thickness,
      placements: b.placements,
      remnants,
      usedArea: b.usedArea,
      wasteArea: Math.max(0, usable - b.usedArea - remnantsArea),
    })
    for (const p of b.placements) {
      if (p.rotated) rotatedQtyByPart.set(p.partId, (rotatedQtyByPart.get(p.partId) ?? 0) + 1)
    }
  })

  const unplaced: UnplacedItem[] = [...chosen.unplaced.values()].sort((a, b) =>
    a.partId === b.partId ? 0 : a.partId < b.partId ? -1 : 1,
  )

  // 采购清单：新开的板按规格聚合
  const purchaseMap = new Map<string, PurchaseLine>()
  for (const b of usedBins) {
    if (b.kind !== 'new' || !b.specId) continue
    const spec = specs.find((s) => s.id === b.specId)!
    const ex = purchaseMap.get(b.specId)
    if (ex) ex.qty += 1
    else
      purchaseMap.set(b.specId, {
        specId: b.specId,
        specName: spec.name,
        length: b.length,
        width: b.width,
        thickness: b.thickness,
        qty: 1,
      })
  }
  const purchase = [...purchaseMap.values()].sort((a, b) =>
    a.thickness !== b.thickness ? a.thickness - b.thickness : a.length * a.width - b.length * b.width,
  )

  // 每厚度统计
  const statMap = new Map<number, NestStat>()
  const allThickness = new Set<number>([
    ...units.map((u) => u.thickness),
    ...sheets.map((s) => s.thickness),
  ])
  for (const t of allThickness) {
    const tSheets = sheets.filter((s) => s.thickness === t)
    const totalParts = units.filter((u) => u.thickness === t).length
    const placedParts = tSheets.reduce((s, sh) => s + sh.placements.length, 0)
    const grossArea = tSheets.reduce((s, sh) => s + sh.length * sh.width, 0)
    const usedArea = tSheets.reduce((s, sh) => s + sh.usedArea, 0)
    statMap.set(t, {
      thickness: t,
      totalParts,
      placedParts,
      sheetCount: tSheets.length,
      newSheetCount: tSheets.filter((s) => s.kind === 'new').length,
      utilization: grossArea > 0 ? usedArea / grossArea : 0,
    })
  }
  const stats = [...statMap.values()].sort((a, b) => a.thickness - b.thickness)

  // 汇总警告：转木纹件必须显式提示人工确认，绝不默认放行
  const resultWarnings = [...warnings]
  const rotatedTotal = [...rotatedQtyByPart.values()].reduce((s, n) => s + n, 0)
  if (rotatedTotal > 0) {
    resultWarnings.push(`有 ${rotatedTotal} 件木纹方向被旋转 90° 摆放（图中橙色标出），请逐件确认后再开料`)
  }
  if (unplaced.length > 0) {
    const n = unplaced.reduce((s, u) => s + u.qty, 0)
    resultWarnings.push(`有 ${n} 件未能排下，见「摆不下的件」清单（未计入采购，请勿漏做)`)
  }

  return {
    sheets,
    unplaced,
    purchase,
    warnings: resultWarnings,
    stats,
  }
}

function round9(n: number): number {
  return Math.round(n * 1e9) / 1e9
}
