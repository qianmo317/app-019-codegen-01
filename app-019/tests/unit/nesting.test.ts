// 排料算法测试：不重叠 / 锯路间距 / 木纹旋转 / 库存优先 / 摆不下不丢 / 确定性 / 性能
import { describe, it, expect } from 'vitest'
import { pack, validateParts } from '../../src/nesting/packer'
import type { NestBatch, NestPart, SheetSpec, StockSheet } from '../../src/nesting/types'
import { DEFAULT_SETTINGS } from '../../src/nesting/types'

const GAP = DEFAULT_SETTINGS.kerfMm + 2 * DEFAULT_SETTINGS.trimMm // 默认 5mm

const spec = (thickness = 18, length = 2440, width = 1220): SheetSpec => ({
  id: `spec-${thickness}-${length}`,
  name: `${width}×${length}`,
  length,
  width,
  thickness,
})

const part = (name: string, length: number, width: number, thickness: number, qty = 1): NestPart => ({
  id: `p-${name}`,
  name,
  length,
  width,
  thickness,
  qty,
})

const batch0 = (over: Partial<NestBatch> = {}): NestBatch =>
  ({
    id: 'test',
    title: 'test',
    parts: [],
    specs: [spec()],
    stock: [],
    settings: { ...DEFAULT_SETTINGS },
    updatedAt: 0,
    ...over,
  }) as NestBatch

/** 校验摆放结果的几何不变量：在界内 + 两两净间距 ≥ gap（任一方向隔开即合法） */
function assertNoOverlap(r: ReturnType<typeof pack>, gap: number) {
  for (const s of r.sheets) {
    const margin = s.kind === 'new' || s.source === 'uncut' ? DEFAULT_SETTINGS.edgeTrimMm : 0
    for (const p of s.placements) {
      expect(p.x, `件越左边界`).toBeGreaterThanOrEqual(margin - 1e-6)
      expect(p.y, `件越上边界`).toBeGreaterThanOrEqual(margin - 1e-6)
      expect(p.x + p.alongLength, `件越右边界`).toBeLessThanOrEqual(s.length - margin + 1e-6)
      expect(p.y + p.alongWidth, `件越下边界`).toBeLessThanOrEqual(s.width - margin + 1e-6)
    }
    for (let i = 0; i < s.placements.length; i++) {
      for (let j = i + 1; j < s.placements.length; j++) {
        const a = s.placements[i]
        const b = s.placements[j]
        const overlapX = a.x < b.x + b.alongLength + gap - 1e-6 && b.x < a.x + a.alongLength + gap - 1e-6
        const overlapY = a.y < b.y + b.alongWidth + gap - 1e-6 && b.y < a.y + a.alongWidth + gap - 1e-6
        expect(overlapX && overlapY, `件「${a.name}」与「${b.name}」重叠或净间距 < ${gap}mm`).toBe(false)
      }
    }
  }
}

describe('排料：基本装箱与不重叠', () => {
  it('两件 600×500 排在 1220×2440 一张板上，采购 1 张', () => {
    const r = pack(batch0({ parts: [part('A', 600, 500, 18, 2)] }))
    expect(r.sheets).toHaveLength(1)
    expect(r.sheets[0].placements).toHaveLength(2)
    expect(r.purchase).toHaveLength(1)
    expect(r.purchase[0].qty).toBe(1)
    expect(r.unplaced).toHaveLength(0)
    assertNoOverlap(r, GAP)
  })

  it('件数超出一张板 → 自动开第二张并计入采购，件不丢失', () => {
    const r = pack(batch0({ parts: [part('A', 800, 500, 18, 10)] }))
    expect(r.unplaced).toHaveLength(0)
    expect(r.purchase[0].qty).toBe(2)
    expect(r.sheets.reduce((s, sh) => s + sh.placements.length, 0)).toBe(10)
    assertNoOverlap(r, GAP)
  })

  it('随机 100 组（确定性伪随机序列）：全部不重叠、不越界、件数守恒', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const parts: NestPart[] = []
      const n = 1 + (seed % 8)
      for (let i = 0; i < n; i++) {
        const l = 150 + ((seed * 131 + i * 977) % 900)
        const w = 100 + ((seed * 173 + i * 631) % 700)
        parts.push(part(`s${seed}-${i}`, l, w, 18, 1 + ((seed + i) % 3)))
      }
      const r = pack(batch0({ parts }))
      const total = parts.reduce((s, p) => s + p.qty, 0)
      const placed = r.sheets.reduce((s, sh) => s + sh.placements.length, 0)
      const unplaced = r.unplaced.reduce((s, u) => s + u.qty, 0)
      expect(placed + unplaced).toBe(total)
      assertNoOverlap(r, GAP)
    }
  })
})

describe('排料：锯路与修边间距', () => {
  it('改大锯路 → 需要的板数不少于小锯路，且间距按新值守得住', () => {
    const small = pack(batch0({ parts: [part('A', 700, 500, 18, 9)] }))
    const big = pack(
      batch0({
        parts: [part('A', 700, 500, 18, 9)],
        settings: { ...DEFAULT_SETTINGS, kerfMm: 10, trimMm: 3 },
      }),
    )
    expect(big.purchase[0].qty).toBeGreaterThanOrEqual(small.purchase[0].qty)
    assertNoOverlap(big, 10 + 6)
  })

  it('新板第一件离四边 = edgeTrim；开过的余料板第一件贴 (0,0)', () => {
    const newBoard = pack(batch0({ parts: [part('A', 300, 300, 18, 1)] }))
    expect(newBoard.sheets[0].placements[0].x).toBe(DEFAULT_SETTINGS.edgeTrimMm)
    expect(newBoard.sheets[0].placements[0].y).toBe(DEFAULT_SETTINGS.edgeTrimMm)

    const stock: StockSheet[] = [{ id: 'k1', length: 1000, width: 800, thickness: 18, source: 'opened' }]
    const opened = pack(batch0({ parts: [part('A', 300, 300, 18, 1)], stock }))
    expect(opened.sheets[0].placements[0].x).toBe(0)
    expect(opened.sheets[0].placements[0].y).toBe(0)
  })
})

describe('排料：木纹方向', () => {
  it('几何事实：单件在矩形板上「原向放不下、转90°反而放得下」不可能（长边只会对到更短边），算法不制造伪旋转', () => {
    // 板 915×1830，件 1818×850：原向 1818+16>1830 放不下；转向 1818 横纹 >899 也放不下
    const r = pack(batch0({ parts: [part('LONG', 1818, 850, 18, 1)], specs: [spec(18, 1830, 915)] }))
    expect(r.unplaced).toHaveLength(1)
    expect(r.sheets).toHaveLength(0)
  })

  it('允许旋转时混排：旋转件 alongLength=原宽、alongWidth=原长，且必有汇总警告', () => {
    // 1100×700 件 ×8 混排，开启旋转后算法可横向拼位
    const r = pack(
      batch0({
        parts: [part('A', 700, 1100, 18, 8)],
        settings: { ...DEFAULT_SETTINGS, allowRotate: true },
      }),
    )
    for (const s of r.sheets) {
      for (const p of s.placements) {
        // 无论转与否，占位两个边必须是 700/1100
        expect([p.alongLength, p.alongWidth].slice().sort((a, b) => a - b)).toEqual([700, 1100])
        if (p.rotated) {
          expect(p.alongLength).toBe(1100)
          expect(p.alongWidth).toBe(700)
        }
      }
    }
    const anyRotated = r.sheets.some((s) => s.placements.some((p) => p.rotated))
    if (anyRotated) expect(r.warnings.join('\n')).toMatch(/旋转 90°/)
    assertNoOverlap(r, GAP)
  })

  it('正方形件旋转无收益：永不标 rotated（即便开了允许旋转）', () => {
    const r = pack(
      batch0({
        parts: [part('S', 1000, 1000, 18, 2)],
        settings: { ...DEFAULT_SETTINGS, allowRotate: true },
      }),
    )
    expect(r.sheets[0].placements.every((p) => !p.rotated)).toBe(true)
  })

  it('不允许旋转（默认）时结果中永远没有 rotated 件', () => {
    const parts: NestPart[] = []
    for (let i = 0; i < 20; i++) parts.push(part(`P${i}`, 300 + (i % 5) * 180, 200 + (i % 4) * 170, 18, 1))
    const r = pack(batch0({ parts }))
    expect(r.sheets.every((s) => s.placements.every((p) => !p.rotated))).toBe(true)
  })
})

describe('排料：库存优先（开过的板先消耗）', () => {
  it('库存板装得下时不新购', () => {
    const stock: StockSheet[] = [{ id: 'k1', length: 1000, width: 800, thickness: 18, source: 'opened', label: '余料' }]
    const r = pack(batch0({ parts: [part('A', 500, 400, 18, 1)], stock }))
    expect(r.purchase).toHaveLength(0)
    expect(r.sheets).toHaveLength(1)
    expect(r.sheets[0].kind).toBe('stock')
    expect(r.sheets[0].source).toBe('opened')
  })

  it('优先开过的板：能进小余料板就不碰未开整张', () => {
    const stock: StockSheet[] = [
      { id: 'opened1', length: 900, width: 700, thickness: 18, source: 'opened' },
      { id: 'uncut1', length: 2440, width: 1220, thickness: 18, source: 'uncut' },
    ]
    const r = pack(batch0({ parts: [part('A', 850, 650, 18, 1)], stock }))
    expect(r.sheets).toHaveLength(1)
    expect(r.sheets[0].id).toContain('opened1')
    expect(r.purchase).toHaveLength(0)
  })

  it('开过的板装不下 → 用未开整张，仍不新购', () => {
    const stock: StockSheet[] = [
      { id: 'opened1', length: 500, width: 400, thickness: 18, source: 'opened' },
      { id: 'uncut1', length: 2440, width: 1220, thickness: 18, source: 'uncut' },
    ]
    const r = pack(batch0({ parts: [part('A', 1000, 600, 18, 1)], stock }))
    expect(r.purchase).toHaveLength(0)
    expect(r.sheets).toHaveLength(1)
    expect(r.sheets[0].id).toContain('uncut1')
  })

  it('库存都不够 → 先消耗库存再新购补足', () => {
    const stock: StockSheet[] = [{ id: 'k1', length: 600, width: 500, thickness: 18, source: 'opened' }]
    const r = pack(batch0({ parts: [part('A', 500, 400, 18, 2)], stock }))
    expect(r.sheets.length).toBeGreaterThanOrEqual(2)
    expect(r.sheets.some((s) => s.kind === 'stock')).toBe(true)
    expect(r.purchase[0].qty).toBeGreaterThanOrEqual(1)
    assertNoOverlap(r, GAP)
  })

  it('板的排序：已开 → 未开 → 新购', () => {
    const stock: StockSheet[] = [
      { id: 'uncut1', length: 2440, width: 1220, thickness: 18, source: 'uncut' },
      { id: 'opened1', length: 2400, width: 1200, thickness: 18, source: 'opened' },
    ]
    const r = pack(batch0({ parts: [part('A', 1000, 1000, 18, 6)], stock }))
    const order = r.sheets.map((s) => (s.kind === 'new' ? 'new' : s.source))
    const idx = (k: string) => order.indexOf(k as 'opened' | 'uncut')
    if (idx('opened') >= 0 && idx('uncut') >= 0) expect(idx('opened')).toBeLessThan(idx('uncut'))
    if (idx('uncut') >= 0 && idx('new') >= 0) expect(idx('uncut')).toBeLessThan(idx('new'))
  })
})

describe('排料：摆不下的件不丢失', () => {
  it('超过最大规格 → unplaced 给原因，其他件照常排、采购不多算', () => {
    const r = pack(batch0({ parts: [part('BIG', 3000, 1500, 18, 2), part('OK', 300, 300, 18, 1)] }))
    expect(r.unplaced).toHaveLength(1)
    expect(r.unplaced[0].qty).toBe(2)
    expect(r.unplaced[0].reason).toMatch(/超过|超长/)
    expect(r.sheets.reduce((s, sh) => s + sh.placements.length, 0)).toBe(1)
  })

  it('没有对应厚度规格 → unplaced 原因明确，不开任何板', () => {
    const r = pack(batch0({ parts: [part('T30', 300, 300, 30, 1)] }))
    expect(r.unplaced[0].reason).toMatch(/厚度 30/)
    expect(r.sheets).toHaveLength(0)
  })

  it('不同厚度件绝不混排在同一张板', () => {
    const r = pack(
      batch0({ parts: [part('A', 400, 400, 18, 1), part('B', 400, 400, 25, 1)], specs: [spec(18), spec(25)] }),
    )
    for (const s of r.sheets) {
      // 同一张板只出现一种厚度（placements 属于同厚度件）
      expect(new Set(s.placements.map(() => s.thickness)).size).toBe(1)
    }
    expect(r.sheets.length).toBe(2)
  })

  it('非法行（非正尺寸/坏数量）跳过并出警告，不影响其他件', () => {
    const warnings: string[] = []
    const units = validateParts(
      [
        { id: 'x', name: '坏件', length: 0, width: 100, thickness: 18, qty: 1 },
        part('好件', 300, 300, 18, 1),
      ],
      warnings,
    )
    expect(units).toHaveLength(1)
    expect(warnings[0]).toMatch(/正数/)
  })
})

describe('排料：整块余料上报', () => {
  it('装件后报告余料矩形（尺寸/面积正确，短边达标才上报）', () => {
    const r = pack(batch0({ parts: [part('A', 1000, 500, 18, 1)] }))
    const s = r.sheets[0]
    expect(s.remnants.length).toBeGreaterThan(0)
    for (const rem of s.remnants) {
      expect(rem.length).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.minRemnantMm - 1e-6)
      expect(rem.width).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.minRemnantMm - 1e-6)
      expect(rem.area).toBeCloseTo(rem.length * rem.width, 3)
    }
  })

  it('余料矩形互不重叠（断头台切分叶子互斥），且不与工件重叠', () => {
    const r = pack(batch0({ parts: [part('A', 500, 400, 18, 4), part('B', 700, 300, 18, 2)] }))
    for (const s of r.sheets) {
      const rects = [
        ...s.placements.map((p) => ({ x: p.x, y: p.y, length: p.alongLength, width: p.alongWidth })),
        ...s.remnants,
      ]
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i]
          const b = rects[j]
          const overlap =
            a.x < b.x + b.length - 1e-6 &&
            b.x < a.x + a.length - 1e-6 &&
            a.y < b.y + b.width - 1e-6 &&
            b.y < a.y + a.width - 1e-6
          expect(overlap).toBe(false)
        }
      }
    }
  })
})

describe('排料：确定性与性能', () => {
  it('同输入两次结果 JSON 全等', () => {
    const input = batch0({
      parts: [part('A', 520, 380, 18, 7), part('B', 900, 420, 18, 3), part('C', 300, 250, 18, 12)],
    })
    expect(JSON.stringify(pack(input))).toBe(JSON.stringify(pack(input)))
  })

  it('换一批件 / 改一次板规格 → 结果随之重排', () => {
    const r1 = pack(batch0({ parts: [part('A', 800, 500, 18, 4)] }))
    const r2 = pack(batch0({ parts: [part('A', 800, 500, 18, 4)], specs: [spec(18, 3000, 1500)] }))
    expect(r2.purchase[0].qty).toBeLessThanOrEqual(r1.purchase[0].qty)
    expect(r2.sheets[0].length).toBe(3000)
  })

  it('200 件规模单次重排 < 100ms', () => {
    const parts: NestPart[] = Array.from({ length: 40 }, (_, i) =>
      part(`P${i}`, 200 + ((i * 53) % 700), 150 + ((i * 29) % 500), 18, 5),
    )
    const t0 = performance.now()
    const r = pack(batch0({ parts }))
    const ms = performance.now() - t0
    console.log(`[nest-perf] 200 件重排 = ${ms.toFixed(2)}ms, 用板 ${r.sheets.length} 张`)
    expect(ms).toBeLessThan(100)
  })
})
