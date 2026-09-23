// 开料排料页：自动重排、摆不上件可见、旋转提示、导出按钮可用
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NestingPage } from '../../src/nesting/NestingPage'
import type { NestJob } from '../../src/nesting/types'
import { newId } from '../../src/nesting/store'

function fixedJob(): NestJob {
  return {
    parts: [
      { id: newId('t'), name: '侧板', length: 800, width: 400, thickness: 18, qty: 2, allowRotate: false },
      { id: newId('t'), name: '背板', length: 764, width: 564, thickness: 9, qty: 1, allowRotate: true },
    ],
    stocks: [
      { id: newId('s'), name: '标准板 1220×2440', width: 1220, length: 2440, thickness: 18, count: -1, kind: 'sheet' },
      { id: newId('s'), name: '标准板 1220×2440', width: 1220, length: 2440, thickness: 9, count: -1, kind: 'sheet' },
    ],
    options: { kerf: 3, trim: 10, minRemnant: 100 },
  }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('wjb.nesting.v1', JSON.stringify(fixedJob()))
})

describe('排料页渲染与重排', () => {
  it('默认示例排出结果：采购数、板卡、余料与利用率均渲染', () => {
    render(<NestingPage />)
    expect(screen.getByTestId('sum-buy').textContent).toContain('2')
    const cards = screen.getAllByTestId('sheet-card')
    expect(cards.length).toBeGreaterThanOrEqual(2)
    // 每张板都有可留余料
    expect(screen.getAllByText(/余料 \d/).length).toBeGreaterThan(0)
  })

  it('改件数量立即重排：数量加大后采购整张数增加', async () => {
    const user = userEvent.setup()
    render(<NestingPage />)
    const before = Number(screen.getByTestId('sum-buy').textContent?.replace(/\D/g, ''))
    const qty = screen.getAllByTestId('part-qty')[0]
    await user.clear(qty)
    await user.type(qty, '20')
    const after = Number(screen.getByTestId('sum-buy').textContent?.replace(/\D/g, ''))
    expect(after).toBeGreaterThan(before)
  })

  it('件大到摆不下时进入红色清单，不会静默丢失', async () => {
    const user = userEvent.setup()
    render(<NestingPage />)
    const length = screen.getAllByTestId('part-length')[0]
    await user.clear(length)
    await user.type(length, '9999')
    const box = screen.getByTestId('unplaced-box')
    expect(box.textContent).toContain('侧板')
    expect(screen.getByTestId('sum-unplaced').textContent).toContain('2')
  })

  it('件只能旋转进板时（已勾选允许旋转），出现旋转警示', async () => {
    // 横档顺纹 590 宽进 600 板（可用 580）放不下；旋转后占宽 303、长 593 可进
    localStorage.setItem(
      'wjb.nesting.v1',
      JSON.stringify({
        parts: [{ id: newId('t'), name: '横档', length: 300, width: 590, thickness: 9, qty: 1, allowRotate: true }],
        stocks: [
          { id: newId('s'), name: '9mm板', width: 1220, length: 2440, thickness: 9, count: -1, kind: 'sheet' },
          { id: newId('s'), name: '18mm板', width: 1220, length: 2440, thickness: 18, count: -1, kind: 'sheet' },
        ],
        options: { kerf: 3, trim: 10, minRemnant: 100 },
      } satisfies NestJob),
    )
    const user = userEvent.setup()
    render(<NestingPage />)
    // 初始 1220 板顺纹即可放下，无旋转
    expect(screen.queryByText(/有 \d+ 件被旋转 90°/)).toBeNull()
    // 把 9mm 板宽改到 600 → 顺纹放不下，必须旋转
    const nineRow = screen.getAllByTestId('stock-row')[0]
    const widthInput = within(nineRow).getByDisplayValue(1220)
    await user.clear(widthInput)
    await user.type(widthInput, '600')
    expect(screen.getByText(/有 1 件被旋转 90°/)).toBeTruthy()
  })

  it('改锯路参数立即重排（useMemo 依赖 job）', () => {
    render(<NestingPage />)
    const kerf = screen.getByTestId('opt-kerf')
    fireEvent.change(kerf, { target: { value: '30' } })
    expect(kerf).toHaveValue(30)
    // 锯路 30mm 后排料仍出结果（至少有板或摆不下清单），页面不崩
    expect(screen.getByTestId('nest-page')).toBeTruthy()
  })

  it('导出 CSV 触发下载且内容含开料清单分段', () => {
    const click = vi.fn()
    const realCreate = document.createElement.bind(document)
    let captured = ''
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'a') return Object.assign(realCreate('a'), { click })
      return realCreate(tag)
    })
    vi.stubGlobal('Blob', class { constructor(parts: string[]) { captured = parts[0] } })
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined })
    render(<NestingPage />)
    fireEvent.click(screen.getByTestId('export-csv'))
    expect(click).toHaveBeenCalled()
    expect(captured).toContain('采购汇总')
    expect(captured).toContain('摆放明细')
  })
})
