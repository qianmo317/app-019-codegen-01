// 排料组件测试：输入即排、采购数/摆不下/旋转警告/库存优先/导出按钮
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NestingPage } from '../../src/nesting/NestingPage'
import { buildCSV, buildTextReport, exportBatchJSON, importBatchJSON } from '../../src/nesting/exporter'
import { makeSampleBatch } from '../../src/nesting/store'
import { pack } from '../../src/nesting/packer'

beforeEach(() => {
  localStorage.clear()
  window.location.hash = ''
})

async function setRows(table: HTMLElement, values: string[][]) {
  const rows = table.querySelectorAll('tbody tr')
  expect(rows.length).toBeGreaterThan(0)
  for (let r = 0; r < values.length; r++) {
    const inputs = rows[r].querySelectorAll('input[type="number"]')
    for (let c = 0; c < values[r].length; c++) {
      fireEvent.change(inputs[c], { target: { value: values[r][c] } })
    }
  }
}

describe('排料页：即时重排 + 采购 + 摆不下', () => {
  it('默认空批次：0 张板；加一行 600×500 → 新购 1 张，全部排下', async () => {
    render(<NestingPage />)
    expect(screen.getByTestId('stat-newsheets').textContent).toBe('0')
    await userEvent.click(screen.getByTestId('add-part'))
    const table = screen.getByTestId('parts-table')
    await setRows(table, [['600', '500', '18', '1']])
    expect(screen.getByTestId('stat-newsheets').textContent).toBe('1')
    expect(screen.getByTestId('stat-placed').textContent).toBe('1/1')
    expect(screen.getAllByTestId(/^sheet-/)).toHaveLength(1)
  })

  it('超大件进摆不下清单且显示原因，不静默丢弃', async () => {
    render(<NestingPage />)
    await userEvent.click(screen.getByTestId('add-part'))
    await setRows(screen.getByTestId('parts-table'), [['3000', '1500', '18', '2']])
    const unplaced = screen.getByTestId('unplaced-section')
    expect(unplaced).toHaveTextContent('工件 1')
    expect(unplaced).toHaveTextContent('超过')
    expect(screen.getByTestId('stat-placed').textContent).toBe('0/2')
    expect(screen.getByTestId('stat-newsheets').textContent).toBe('0')
  })

  it('库存开过的板够用 → 新购 0 张且标注优先消耗', async () => {
    render(<NestingPage />)
    await userEvent.click(screen.getByTestId('add-part'))
    await setRows(screen.getByTestId('parts-table'), [['500', '400', '18', '1']])
    // 加一块开过的库存板 1000×800
    await userEvent.click(within(document.body).getByText('＋ 加开过的板'))
    expect(screen.getByTestId('stat-newsheets').textContent).toBe('0')
    const sheet = screen.getByTestId('sheet-1')
    expect(sheet).toHaveTextContent('已开余料板')
  })

  it('勾选允许旋转后，能省板的旋转方案被采用并出现旋转确认警告条', async () => {
    render(<NestingPage />)
    // 1100(顺纹)×700 件 ×8：顺纹排需 4 张，横过来拼 3 张即可 → 必然触发旋转
    for (let i = 0; i < 8; i++) await userEvent.click(screen.getByTestId('add-part'))
    const rows = screen.getAllByTestId('parts-table')[0].querySelectorAll('tbody tr')
    rows.forEach((row) => {
      const inputs = row.querySelectorAll('input[type="number"]')
      fireEvent.change(inputs[0], { target: { value: '1100' } })
      fireEvent.change(inputs[1], { target: { value: '700' } })
      fireEvent.change(inputs[2], { target: { value: '18' } })
      fireEvent.change(inputs[3], { target: { value: '1' } })
    })
    expect(screen.queryByTestId('nest-warnings')).toBeNull()
    await userEvent.click(screen.getByTestId('set-rotate'))
    const warnings = screen.getByTestId('nest-warnings')
    expect(warnings).toHaveTextContent(/旋转 90°/)
    // 旋转后省到 3 张板
    expect(screen.getByTestId('stat-newsheets').textContent).toBe('3')
  })

  it('改锯路即时重排（重排耗时标注存在且为数字）', async () => {
    render(<NestingPage />)
    await userEvent.click(screen.getByTestId('add-part'))
    const recalc = screen.getByTestId('nest-recalc')
    expect(recalc.textContent).toMatch(/重排耗时 [\d.]+ms/)
    const kerf = screen.getByTestId('set-kerf')
    fireEvent.change(kerf, { target: { value: '20' } })
    expect(recalc.textContent).toMatch(/重排耗时 [\d.]+ms/)
  })
})

describe('排料导出：CSV / TXT / JSON 往返', () => {
  it('CSV 含采购、摆放明细、余料、摆不下四段，且件名不丢', () => {
    const b = makeSampleBatch()
    // 手动塞一个超大件，覆盖摆不下段
    b.parts.push({ id: 'px', name: '超大台面', length: 3000, width: 1500, thickness: 18, qty: 1 })
    const result = pack(b)
    const withResult = { ...b, result }
    const text = buildCSV(withResult)
    expect(text).toContain('采购清单')
    expect(text).toContain('鞋柜侧板')
    expect(text).toContain('可留整块余料')
    expect(text).toContain('摆不下的件')
    expect(text).toContain('超大台面')
    // TXT 开料单
    const txt = buildTextReport(withResult)
    expect(txt).toContain('【一、采购】')
    expect(txt).toContain('【二、每张板摆了哪些件】')
    expect(txt).toContain('【三、摆不下的件')
    // 库存板被优先使用（示例自带一块 opened）
    if (result.sheets.some((s) => s.kind === 'stock')) expect(txt).toContain('已开余料板')
  })

  it('批次 JSON 导出再导入完全一致', () => {
    const b = makeSampleBatch()
    const restored = importBatchJSON(exportBatchJSON(b))
    expect(JSON.stringify(restored)).toBe(JSON.stringify(b))
  })

  it('导入校验拒绝坏结构', () => {
    expect(() => importBatchJSON('{}')).toThrow(/id\/title/)
    expect(() => importBatchJSON('not json')).toThrow()
    expect(() => importBatchJSON(JSON.stringify({ id: '1', title: 't', parts: [] }))).toThrow(/specs/)
  })
})
