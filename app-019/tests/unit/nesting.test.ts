// 开料排料引擎测试：不重叠、锯路/修边、木纹旋转、余料优先、张数限制、摆不下不丢弃、改输入重排
import { describe, it, expect } from 'vitest'
import { nest } from '../../src/nesting/engine'
import { buildCuttingCSV } from '../../src/nesting/export'
import type { NestJob, NestPart, Placement, Rect, StockDef, UsedStock } from '../../src/nesting/types'

let idc = 0
const pid = () => `p${++idc}`
const sid = () => `s${++idc}`

function part(p: Partial<NestPart> & Pick<NestPart, 'length' | 'width' | 'thickness'>): NestPart {
  return { id: pid(), name: '件', qty: 1, allowRotate: false, ...p }
}

function sheet(s: Partial<StockDef> & Pick<StockDef, 'width' | 'length' | 'thickness'>): StockDef {
  return { id: sid(), name: '板', count: -1, kind: 'sheet', ...s }
}

function job(parts: NestPart[], stocks: StockDef[], opts?: Partial<NestJob['options']>): NestJob {
  return {
    parts,
    stocks,
    options: { kerf: 3, trim: 10, minRemnant: 100, ...opts },
  }
}

/** 矩形相交（膨胀 kerf 后不得重叠，即任意两件间距 >= kerf） */
function overlap(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap - 1e-6 &&
    a.x + a.w + gap > b.x + 1e-6 &&
    a.y < b.y + b.h + gap - 1e-6 &&
    a.y + a.h + gap > b.y + 1e-6
  )
}

function allPlacements(sheets: UsedStock[]): { sheet: UsedStock; pl: Placement }[] {
  return sheets.flatMap((s) => s.placements.map((pl) => ({ sheet: s, pl })))
}

describe('基本摆放与边界', () => {
  it('单件顺纹摆进一张板，坐标含修边量', () => {
    const r = nest(job([part({ length: 500, width: 300, thickness: 18 })], [sheet({ width: 1220, length: 2440, thickness: 18 })]))
    expect(r.sheets).toHaveLength(1)
    const pl = r.sheets[0].placements[0]
    expect(pl.x).toBe(10)
    expect(pl.y).toBe(10)
    expect(pl.rotated).toBe(false)
    expect(r.purchaseCount).toBe(1)
    expect(r.unplaced).toHaveLength(0)
  })

  it('所有件都在板内，并守住四周修边', () => {
    const parts = [
      part({ length: 800, width: 400, thickness: 18, qty: 3 }),
      part({ length: 600, width: 400, thickness: 18, qty: 2 }),
    ]
    const r = nest(job(parts, [sheet({ width: 1220, length: 2440, thickness: 18 })], { trim: 10 }))
    for (const s of r.sheets) {
      for (const pl of s.placements) {
        expect(pl.x).toBeGreaterThanOrEqual(10 - 1e-6)
        expect(pl.y).toBeGreaterThanOrEqual(10 - 1e-6)
        expect(pl.x + pl.w).toBeLessThanOrEqual(s.width - 10 + 1e-6)
        expect(pl.y + pl.h).toBeLessThanOrEqual(s.length - 10 + 1e-6)
      }
    }
  })

  it('同板任意两件间距 >= 锯路 kerf（不重叠）', () => {
    const parts = Array.from({ length: 12 }, () => part({ length: 400, width: 300, thickness: 18 }))
    const r = nest(job(parts, [sheet({ width: 1220, length: 2440, thickness: 18 })], { kerf: 5 }))
    for (const s of r.sheets) {
      const ps = s.placements
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          expect(overlap(ps[i], ps[j], 5)).toBe(false)
        }
      }
    }
    expect(r.unplaced).toHaveLength(0)
  })
})

describe('木纹方向', () => {
  it('默认不许旋转：竖长件横放不进时不能转，必须新开板或摆不下', () => {
    // 板可用宽 600-20=580；件顺纹宽 590 > 580，长 300；不允许旋转
    const r = nest(
      job([part({ length: 300, width: 590, thickness: 18, allowRotate: false })], [
        sheet({ width: 600, length: 2440, thickness: 18 }),
      ]),
    )
    // 顺纹沿长 300 <= 2420 且宽 590 > 580，任何朝向只有允许旋转才可能换长宽——旋转后宽 300、长 590，实际也能进，但禁止旋转
    // 顺纹：w=590+kerf > 580 → 放不进；所以 1 件摆不下
    expect(r.sheets.every((s) => s.placements.every((p) => !p.rotated))).toBe(true)
    expect(r.unplaced.reduce((n, u) => n + u.qty, 0)).toBe(1)
  })

  it('允许旋转才会转，且结果中旋转件被计数并出现在警示里', () => {
    const r = nest(
      job([part({ length: 300, width: 590, thickness: 18, allowRotate: true, name: '横档' })], [
        sheet({ width: 600, length: 2440, thickness: 18 }),
      ]),
    )
    expect(r.unplaced).toHaveLength(0)
    const rotated = allPlacements(r.sheets).filter((x) => x.pl.rotated)
    expect(rotated).toHaveLength(1)
    expect(r.rotatedCount).toBe(1)
    expect(r.warnings.join('')).toContain('旋转')
  })
})

describe('余料板 / 张数 / 采购', () => {
  it('优先使用已开过的余料板，再用市售整张', () => {
    const remnant = sheet({ width: 700, length: 900, thickness: 18, count: 1, kind: 'remnant', name: '余料' })
    const full = sheet({ width: 1220, length: 2440, thickness: 18, count: -1, name: '标准板' })
    const r = nest(job([part({ length: 500, width: 300, thickness: 18, qty: 4 })], [remnant, full]))
    // 第一张必须是余料板
    expect(r.sheets[0].kind).toBe('remnant')
    // 余料板上至少摆了件
    expect(r.sheets[0].placements.length).toBeGreaterThan(0)
  })

  it('有限张数用完后，不再多开该规格', () => {
    const limited = sheet({ width: 600, length: 600, thickness: 18, count: 1, name: '库存一张' })
    const r = nest(job([part({ length: 500, width: 500, thickness: 18, qty: 3 })], [limited]))
    expect(r.sheets).toHaveLength(1)
    const missing = r.unplaced.reduce((n, u) => n + u.qty, 0)
    expect(missing).toBe(2)
    expect(r.unplaced[0].reason).toBe('stock-exhausted')
  })

  it('采购汇总只计 count=-1 的市售整张，余料板不计采购', () => {
    const remnant = sheet({ width: 1200, length: 2000, thickness: 18, count: 2, kind: 'remnant', name: '余料' })
    const full = sheet({ width: 1220, length: 2440, thickness: 18, count: -1, name: '标准板' })
    const r = nest(job([part({ length: 1000, width: 1100, thickness: 18, qty: 3 })], [remnant, full]))
    // 两张余料板各放 1 件，第 3 件才开 1 张市售板；余料板不进采购
    expect(r.purchaseCount).toBe(1)
    expect(r.purchases).toHaveLength(1)
    expect(r.purchases[0].name).toBe('标准板')
  })
})

describe('摆不下的件不丢弃', () => {
  it('没有该厚度的板 → no-stock', () => {
    const r = nest(job([part({ length: 300, width: 200, thickness: 25 })], [sheet({ width: 1220, length: 2440, thickness: 18 })]))
    expect(r.unplaced[0].reason).toBe('no-stock')
    expect(r.unplaced[0].qty).toBe(1)
  })

  it('件比任何板都大 → too-large，即使板无限也不硬塞', () => {
    const r = nest(job([part({ length: 3000, width: 1000, thickness: 18 })], [sheet({ width: 1220, length: 2440, thickness: 18 })]))
    expect(r.unplaced[0].reason).toBe('too-large')
    expect(r.sheets).toHaveLength(0)
  })

  it('部分摆下时只报缺的数量', () => {
    const r = nest(
      job([part({ length: 2000, width: 1100, thickness: 18, qty: 5 })], [sheet({ width: 1220, length: 2440, thickness: 18, count: 2 })]),
    )
    // 每张板顺纹只能放 1 件（2003+2003 > 2420），两张放 2 件，缺 3
    expect(r.sheets).toHaveLength(2)
    expect(r.unplaced[0].qty).toBe(3)
  })
})

describe('厚度分组与重排', () => {
  it('不同厚度的件绝不混到同一张板上', () => {
    const r = nest(
      job(
        [part({ length: 400, width: 300, thickness: 18 }), part({ length: 400, width: 300, thickness: 9 })],
        [sheet({ width: 1220, length: 2440, thickness: 18 }), sheet({ width: 1220, length: 2440, thickness: 9 })],
      ),
    )
    for (const s of r.sheets) {
      const th = new Set(s.placements.map(() => s.thickness))
      expect(th.size).toBe(1)
    }
    expect(r.sheets.length).toBe(2)
  })

  it('改板规格后结果随之变化（件装不进小规格 → 自动开更大的）', () => {
    const parts = [part({ length: 2000, width: 600, thickness: 18, qty: 1 })]
    const small = nest(job(parts, [sheet({ width: 900, length: 1800, thickness: 18 })]))
    expect(small.unplaced).toHaveLength(1)
    const big = nest(job(parts, [sheet({ width: 1220, length: 2440, thickness: 18 })]))
    expect(big.unplaced).toHaveLength(0)
    expect(big.sheets).toHaveLength(1)
  })

  it('加大锯路/修边会改变可装数量，参数变更即重排', () => {
    const parts = Array.from({ length: 12 }, () => part({ length: 400, width: 500, thickness: 18 }))
    // 宽松：可用 1180×2400，占位 510×410 → 2 列×5 行=10/张 → 2 张
    const loose = nest(job(parts, [sheet({ width: 1220, length: 2440, thickness: 18 })], { kerf: 10, trim: 20 }))
    // 紧贴：占位 501×401 → 2 列×6 行=12/张 → 1 张
    const tight = nest(job(parts, [sheet({ width: 1220, length: 2440, thickness: 18 })], { kerf: 1, trim: 0 }))
    expect(loose.sheets.length).toBe(2)
    expect(tight.sheets.length).toBe(1)
  })
})

describe('余料报告与导出', () => {
  it('报告的余料尺寸不小于最小短边阈值，且不与件重叠', () => {
    const r = nest(
      job([part({ length: 500, width: 300, thickness: 18, qty: 2 })], [sheet({ width: 1220, length: 2440, thickness: 18 })], {
        minRemnant: 100,
      }),
    )
    for (const s of r.sheets) {
      for (const rem of s.remnants) {
        expect(Math.min(rem.w, rem.h)).toBeGreaterThanOrEqual(100 - 1e-6)
        for (const pl of s.placements) expect(overlap(rem, pl, 0)).toBe(false)
      }
    }
    expect(r.usableRemnantArea).toBeGreaterThan(0)
  })

  it('CSV 清单包含采购、每板件、余料、摆不下分段，可照着开料', () => {
    const r = nest(
      job(
        [part({ length: 500, width: 300, thickness: 18, qty: 2 }), part({ length: 3000, width: 2000, thickness: 18 })],
        [sheet({ name: '标准板', width: 1220, length: 2440, thickness: 18 })],
      ),
    )
    const csv = buildCuttingCSV(
      job(
        [part({ length: 500, width: 300, thickness: 18, qty: 2 }), part({ length: 3000, width: 2000, thickness: 18 })],
        [sheet({ name: '标准板', width: 1220, length: 2440, thickness: 18 })],
      ),
      r,
    )
    expect(csv).toContain('采购汇总')
    expect(csv).toContain('摆放明细')
    expect(csv).toContain('余料')
    expect(csv).toContain('摆不下')
  })
})

describe('数量守恒', () => {
  it('摆下数 + 摆不下数 = 需求总数', () => {
    const parts = [
      part({ length: 700, width: 500, thickness: 18, qty: 6 }),
      part({ length: 300, width: 250, thickness: 9, qty: 4 }),
      part({ length: 5000, width: 100, thickness: 18, qty: 2 }),
    ]
    const r = nest(job(parts, [sheet({ width: 1220, length: 2440, thickness: 18 }), sheet({ width: 1220, length: 2440, thickness: 9, count: 1 })]))
    const placed = r.sheets.reduce((n, s) => n + s.placements.length, 0)
    const missing = r.unplaced.reduce((n, u) => n + u.qty, 0)
    expect(placed + missing).toBe(12)
  })
})
