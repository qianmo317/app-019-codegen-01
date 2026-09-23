// 开料排料页：编辑件清单与板规格，自动重排，展示买板数、每板明细、余料、摆不下件，支持导出
import { useEffect, useMemo, useState } from 'react'
import type { NestJob, NestOptions, NestPart, StockDef } from './types'
import { UNPLACED_REASON_LABEL } from './types'
import { nest } from './engine'
import { downloadCSV, downloadJobJSON } from './export'
import { DEFAULT_OPTIONS, STOCK_PRESETS, loadJob, newId, saveJob } from './store'
import { SheetSvg } from './SheetSvg'

export function NestingPage() {
  const [job, setJob] = useState<NestJob>(() => loadJob())

  useEffect(() => {
    saveJob(job)
  }, [job])

  // 任何改动都重排（换批件、改数量、改板规格、改锯路……）
  const result = useMemo(() => nest(job), [job])

  const updatePart = (id: string, patch: Partial<NestPart>) =>
    setJob((j) => ({ ...j, parts: j.parts.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
  const addPart = () =>
    setJob((j) => ({
      ...j,
      parts: [...j.parts, { id: newId('t'), name: '新件', length: 300, width: 150, thickness: 18, qty: 1, allowRotate: false }],
    }))
  const removePart = (id: string) => setJob((j) => ({ ...j, parts: j.parts.filter((p) => p.id !== id) }))

  const updateStock = (id: string, patch: Partial<StockDef>) =>
    setJob((j) => ({ ...j, stocks: j.stocks.map((s) => (s.id === id ? { ...s, ...patch } : s)) }))
  const addStock = (preset?: (typeof STOCK_PRESETS)[number]) =>
    setJob((j) => ({
      ...j,
      stocks: [
        ...j.stocks,
        preset
          ? { ...preset, id: newId('s'), count: -1, kind: 'sheet' as const }
          : { id: newId('s'), name: '余料板', width: 600, length: 800, thickness: 18, count: 1, kind: 'remnant' as const },
      ],
    }))
  const removeStock = (id: string) => setJob((j) => ({ ...j, stocks: j.stocks.filter((s) => s.id !== id) }))

  const setOption = (patch: Partial<NestOptions>) => setJob((j) => ({ ...j, options: { ...j.options, ...patch } }))

  const totalParts = job.parts.reduce((n, p) => n + Math.max(0, p.qty), 0)
  const unplacedQty = result.unplaced.reduce((n, u) => n + u.qty, 0)
  const totalArea = result.sheets.reduce((a, s) => a + s.width * s.length, 0)
  const usedArea = result.sheets.reduce((a, s) => a + s.placements.reduce((z, p) => z + p.w * p.h, 0), 0)
  const rate = totalArea > 0 ? ((usedArea / totalArea) * 100).toFixed(1) : '—'

  return (
    <div className="page nest-page" data-testid="nest-page">
      <div className="page-head">
        <h1>开料排料</h1>
        <div className="head-actions no-print">
          <button className="btn btn-secondary" data-testid="export-csv" onClick={() => downloadCSV(job, result)}>
            导出开料清单 CSV
          </button>
          <button className="btn btn-secondary" data-testid="export-json" onClick={() => downloadJobJSON(job, result)}>
            导出 JSON
          </button>
          <button className="btn btn-secondary" data-testid="print" onClick={() => window.print()}>
            打印 / 存 PDF
          </button>
          <button
            className="btn btn-secondary"
            data-testid="reset-options"
            onClick={() => setJob((j) => ({ ...j, options: { ...DEFAULT_OPTIONS } }))}
          >
            参数恢复默认
          </button>
        </div>
      </div>

      <div className="nest-grid">
        <section className="nest-input no-print">
          <h2>1. 件清单（长=顺纹，宽=横纹，厚）</h2>
          <table className="nest-table" data-testid="parts-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>长 mm</th>
                <th>宽 mm</th>
                <th>厚 mm</th>
                <th>数量</th>
                <th>可旋转</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {job.parts.map((p) => (
                <tr key={p.id} data-testid="part-row">
                  <td>
                    <input type="text" value={p.name} onChange={(e) => updatePart(p.id, { name: e.target.value })} />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      value={p.length}
                      data-testid="part-length"
                      onChange={(e) => updatePart(p.id, { length: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      value={p.width}
                      onChange={(e) => updatePart(p.id, { width: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      value={p.thickness}
                      onChange={(e) => updatePart(p.id, { thickness: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      value={p.qty}
                      data-testid="part-qty"
                      onChange={(e) => updatePart(p.id, { qty: Number(e.target.value) })}
                    />
                  </td>
                  <td className="center">
                    <input
                      type="checkbox"
                      checked={p.allowRotate}
                      title="允许转 90°（会在结果中标出待确认）"
                      onChange={(e) => updatePart(p.id, { allowRotate: e.target.checked })}
                    />
                  </td>
                  <td>
                    <button className="btn btn-sm btn-danger" onClick={() => removePart(p.id)}>
                      删
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn btn-secondary btn-sm" data-testid="add-part" onClick={addPart}>
            + 添加件
          </button>

          <h2>2. 板材（市售规格 / 已开余料板）</h2>
          <table className="nest-table" data-testid="stocks-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>宽 mm</th>
                <th>长 mm</th>
                <th>厚 mm</th>
                <th>张数</th>
                <th>类型</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {job.stocks.map((s) => (
                <tr key={s.id} data-testid="stock-row">
                  <td>
                    <input type="text" value={s.name} onChange={(e) => updateStock(s.id, { name: e.target.value })} />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      value={s.width}
                      onChange={(e) => updateStock(s.id, { width: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      value={s.length}
                      onChange={(e) => updateStock(s.id, { length: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      value={s.thickness}
                      onChange={(e) => updateStock(s.id, { thickness: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={-1}
                      value={s.count}
                      title="-1 = 市售规格，需要几张买几张"
                      onChange={(e) => updateStock(s.id, { count: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <select
                      value={s.kind}
                      onChange={(e) => updateStock(s.id, { kind: e.target.value as StockDef['kind'] })}
                    >
                      <option value="sheet">整张</option>
                      <option value="remnant">余料板（优先）</option>
                    </select>
                  </td>
                  <td>
                    <button className="btn btn-sm btn-danger" onClick={() => removeStock(s.id)}>
                      删
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="stock-actions">
            <button className="btn btn-secondary btn-sm" data-testid="add-stock" onClick={() => addStock()}>
              + 添加余料板
            </button>
            {STOCK_PRESETS.map((p, i) => (
              <button key={i} className="btn btn-sm" onClick={() => addStock(p)}>
                + {p.name} t{p.thickness}
              </button>
            ))}
          </div>

          <h2>3. 锯路与修边</h2>
          <div className="filters">
            <label>
              件间距（锯路+修边）mm
              <input
                type="number"
                min={0}
                value={job.options.kerf}
                data-testid="opt-kerf"
                onChange={(e) => setOption({ kerf: Number(e.target.value) })}
              />
            </label>
            <label>
              板四周修边 mm
              <input
                type="number"
                min={0}
                value={job.options.trim}
                data-testid="opt-trim"
                onChange={(e) => setOption({ trim: Number(e.target.value) })}
              />
            </label>
            <label>
              余料最小短边 mm
              <input
                type="number"
                min={0}
                value={job.options.minRemnant}
                onChange={(e) => setOption({ minRemnant: Number(e.target.value) })}
              />
            </label>
          </div>
        </section>

        <section className="nest-result">
          <div className="summary-cards">
            <div className="summary-card" data-testid="sum-buy">
              <span className="summary-num">{result.purchaseCount}</span>
              <span className="summary-label">需购整张</span>
            </div>
            <div className="summary-card">
              <span className="summary-num">{result.sheets.length}</span>
              <span className="summary-label">实际开板数</span>
            </div>
            <div className="summary-card">
              <span className="summary-num">{totalParts}</span>
              <span className="summary-label">件总数</span>
            </div>
            <div className={`summary-card ${unplacedQty > 0 ? 'bad' : ''}`} data-testid="sum-unplaced">
              <span className="summary-num">{unplacedQty}</span>
              <span className="summary-label">摆不下</span>
            </div>
            <div className="summary-card">
              <span className="summary-num">{rate}%</span>
              <span className="summary-label">面积利用率</span>
            </div>
            <div className={`summary-card ${result.rotatedCount > 0 ? 'warn' : ''}`}>
              <span className="summary-num">{result.rotatedCount}</span>
              <span className="summary-label">旋转待确认</span>
            </div>
          </div>

          {result.warnings.map((w, i) => (
            <p className="nest-warning" key={i} role="alert">
              ⚠ {w}
            </p>
          ))}

          {result.unplaced.length > 0 && (
            <div className="unplaced-box" data-testid="unplaced-box">
              <h2>摆不下的件（未计入开料，需另行处理）</h2>
              <table className="nest-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>厚 mm</th>
                    <th>缺数量</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {result.unplaced.map((u) => (
                    <tr key={u.partId}>
                      <td>{u.name}</td>
                      <td>{u.thickness}</td>
                      <td>{u.qty}</td>
                      <td>{UNPLACED_REASON_LABEL[u.reason]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2>采购清单</h2>
          {result.purchases.length === 0 ? (
            <p className="empty-inline">库存余料板够用，无需购板</p>
          ) : (
            <table className="nest-table compact" data-testid="purchase-table">
              <thead>
                <tr>
                  <th>规格</th>
                  <th>宽×长 mm</th>
                  <th>厚 mm</th>
                  <th>张数</th>
                </tr>
              </thead>
              <tbody>
                {result.purchases.map((p) => (
                  <tr key={p.stockId}>
                    <td>{p.name}</td>
                    <td>
                      {p.width}×{p.length}
                    </td>
                    <td>{p.thickness}</td>
                    <td>{p.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>每张板摆法与余料</h2>
          <div className="sheet-cards">
            {result.sheets.map((s) => {
              const used = s.placements.reduce((a, p) => a + p.w * p.h, 0)
              const r = ((used / (s.width * s.length)) * 100).toFixed(1)
              return (
                <div className="sheet-card" key={s.sheetNo} data-testid="sheet-card">
                  <div className="sheet-card-head">
                    <strong>
                      板 #{s.sheetNo}
                      {s.kind === 'remnant' ? '（已有余料板）' : ''}
                    </strong>
                    <span>
                      {s.name} · {s.width}×{s.length}×{s.thickness} · 利用率 {r}%
                    </span>
                  </div>
                  <SheetSvg sheet={s} />
                  <ul className="placement-list">
                    {s.placements.map((p, i) => (
                      <li key={i} className={p.rotated ? 'rotated-text' : ''}>
                        {p.name} #{p.qtyIndex}：距左 {p.x}，距顶 {p.y}，{p.w}×{p.h}
                        {p.rotated ? '（旋转 90°，待确认木纹）' : ''}
                      </li>
                    ))}
                    {s.remnants.length === 0 && <li className="muted">无可整块留用的余料</li>}
                    {s.remnants.map((rem, i) => (
                      <li key={`rem${i}`} className="muted">
                        余料 {rem.w}×{rem.h} mm（距左 {rem.x}，距顶 {rem.y}）
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
            {result.sheets.length === 0 && <p className="empty-inline">还没有可排的件</p>}
          </div>
        </section>
      </div>
    </div>
  )
}
