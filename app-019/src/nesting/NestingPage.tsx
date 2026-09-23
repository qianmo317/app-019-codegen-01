// 开料排料页：编辑工件/板材/库存 → 即时重排 → 采购数、每板明细、余料、摆不下、导出
import { useEffect, useMemo, useState } from 'react'
import type { NestBatch, NestPart, NestSettings, SheetSpec, StockSheet } from './types'
import { PRESET_SPECS } from './types'
import { pack } from './packer'
import { buildCSV, buildTextReport, downloadText, exportBatchJSON, importBatchJSON } from './exporter'
import { getBatch, loadBatches, makeBatch, makeSampleBatch, newId, upsertBatch, deleteBatch } from './store'
import { SheetSvg } from './SheetSvg'
import { fmt01 } from '../lib/format'
import { navigate } from '../router'

const DRAFT_KEY = 'wjb.nesting.draft'

function emptyDraft(): NestBatch {
  const b = makeBatch('未命名批次')
  return b
}

function loadDraft(): NestBatch {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (raw) return JSON.parse(raw) as NestBatch
  } catch {
    /* ignore */
  }
  return emptyDraft()
}

export function NestingPage({ id }: { id?: string }) {
  const saved = id ? getBatch(id) : undefined
  const [batch, setBatch] = useState<NestBatch>(() => saved ?? loadDraft())
  const [savedList, setSavedList] = useState<NestBatch[]>(() => loadBatches())
  const [importError, setImportError] = useState('')

  // 路由换批次时重新载入
  useEffect(() => {
    setBatch(id ? getBatch(id) ?? loadDraft() : loadDraft())
  }, [id])

  // 未保存批次实时写草稿；改任何输入即重排（同输入确定性结果，不存在旧结果残留）
  useEffect(() => {
    if (!id) localStorage.setItem(DRAFT_KEY, JSON.stringify(batch))
  }, [batch, id])

  const { result, ms } = useMemo(() => {
    const t = performance.now()
    const r = pack(batch)
    return { result: r, ms: performance.now() - t }
  }, [batch])

  const update = (patch: Partial<NestBatch>) => setBatch((b) => ({ ...b, ...patch, updatedAt: Date.now() }))

  const save = () => {
    const withResult: NestBatch = { ...batch, result, updatedAt: Date.now() }
    upsertBatch(withResult)
    setSavedList(loadBatches())
    navigate(`/nesting/${withResult.id}`)
  }

  const saveAsNew = () => {
    const copy: NestBatch = JSON.parse(JSON.stringify({ ...batch, result }))
    copy.id = newId()
    copy.updatedAt = Date.now()
    upsertBatch(copy)
    navigate(`/nesting/${copy.id}`)
  }

  // —— 工件表编辑 ——
  const setPart = (pid: string, patch: Partial<NestPart>) =>
    update({ parts: batch.parts.map((p) => (p.id === pid ? { ...p, ...patch } : p)) })
  const addPart = () =>
    update({
      parts: [
        ...batch.parts,
        { id: newId('p'), name: `工件 ${batch.parts.length + 1}`, length: 400, width: 200, thickness: 18, qty: 1 },
      ],
    })
  const removePart = (pid: string) => update({ parts: batch.parts.filter((p) => p.id !== pid) })

  // —— 规格表编辑 ——
  const setSpec = (sid: string, patch: Partial<SheetSpec>) =>
    update({ specs: batch.specs.map((s) => (s.id === sid ? { ...s, ...patch } : s)) })
  const addSpec = () =>
    update({
      specs: [
        ...batch.specs,
        { id: newId('s'), name: '自定义板材', length: 2440, width: 1220, thickness: 18 },
      ],
    })
  const addPreset = (preset: (typeof PRESET_SPECS)[number]) =>
    update({ specs: [...batch.specs, { ...preset, id: newId('s') }] })
  const removeSpec = (sid: string) => update({ specs: batch.specs.filter((s) => s.id !== sid) })

  // —— 库存板编辑 ——
  const setStock = (kid: string, patch: Partial<StockSheet>) =>
    update({ stock: batch.stock.map((k) => (k.id === kid ? { ...k, ...patch } : k)) })
  const addStock = (source: StockSheet['source']) =>
    update({
      stock: [
        ...batch.stock,
        { id: newId('k'), length: 1200, width: 600, thickness: 18, source, label: source === 'opened' ? '开剩的余料板' : '未开整张' },
      ],
    })
  const removeStock = (kid: string) => update({ stock: batch.stock.filter((k) => k.id !== kid) })

  const setSettings = (patch: Partial<NestSettings>) => update({ settings: { ...batch.settings, ...patch } })

  const loadSample = () => setBatch(makeSampleBatch())
  const resetDraft = () => setBatch(emptyDraft())

  const onImportFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const imported = importBatchJSON(String(reader.result ?? ''))
        imported.id = newId()
        imported.updatedAt = Date.now()
        upsertBatch(imported)
        setSavedList(loadBatches())
        navigate(`/nesting/${imported.id}`)
        setImportError('')
      } catch (e) {
        setImportError(e instanceof Error ? e.message : '导入失败')
      }
    }
    reader.readAsText(file)
  }

  const totalParts = batch.parts.reduce((s, p) => s + p.qty, 0)
  const placedQty = result.sheets.reduce((s, sh) => s + sh.placements.length, 0)
  const unplacedQty = result.unplaced.reduce((s, u) => s + u.qty, 0)
  const newSheetQty = result.purchase.reduce((s, p) => s + p.qty, 0)
  const totalRemnantArea = result.sheets.reduce(
    (s, sh) => s + sh.remnants.reduce((a, r) => a + r.area, 0),
    0,
  )

  return (
    <div className="page nesting-page" data-testid="nesting-page">
      <div className="page-head">
        <h1>开料排料</h1>
        <div className="head-actions">
          <input
            className="nest-title-input"
            data-testid="nest-title"
            value={batch.title}
            onChange={(e) => update({ title: e.target.value })}
          />
          <button className="btn btn-secondary" data-testid="nest-sample" onClick={loadSample}>
            载入示例
          </button>
          <button className="btn btn-secondary" onClick={resetDraft}>清空重开</button>
          <label className="btn btn-secondary">
            导入批次 JSON
            <input
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onImportFile(f)
                e.target.value = ''
              }}
            />
          </label>
          <button className="btn btn-primary" data-testid="nest-save" onClick={save}>
            保存批次
          </button>
          {id && (
            <button className="btn btn-secondary" onClick={saveAsNew}>另存为新批次</button>
          )}
        </div>
      </div>

      {importError && <p className="error" role="alert">{importError}</p>}

      {savedList.length > 0 && (
        <div className="nest-saved-bar">
          已存批次：
          {savedList.map((b) => (
            <span key={b.id} className="nest-saved-chip">
              <button
                className={b.id === id ? 'nest-chip-link active' : 'nest-chip-link'}
                onClick={() => navigate(`/nesting/${b.id}`)}
              >
                {b.title}
              </button>
              <button
                className="nest-chip-del"
                title="删除批次"
                onClick={() => {
                  deleteBatch(b.id)
                  setSavedList(loadBatches())
                  if (b.id === id) navigate('/nesting')
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="nest-layout">
        {/* 左：输入 */}
        <div className="nest-inputs">
          <section className="nest-card">
            <h2>
              ① 要做的件（共 {totalParts} 件）
              <span className="nest-hint">「长」沿木纹方向</span>
            </h2>
            <table className="nest-table" data-testid="parts-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>长(顺纹)</th>
                  <th>宽</th>
                  <th>厚</th>
                  <th>数量</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {batch.parts.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <input
                        className="nest-name-input"
                        value={p.name}
                        onChange={(e) => setPart(p.id, { name: e.target.value })}
                      />
                    </td>
                    <td><input type="number" min={1} value={p.length} onChange={(e) => setPart(p.id, { length: Number(e.target.value) })} /></td>
                    <td><input type="number" min={1} value={p.width} onChange={(e) => setPart(p.id, { width: Number(e.target.value) })} /></td>
                    <td><input type="number" min={1} value={p.thickness} onChange={(e) => setPart(p.id, { thickness: Number(e.target.value) })} /></td>
                    <td><input type="number" min={1} step={1} value={p.qty} onChange={(e) => setPart(p.id, { qty: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} /></td>
                    <td><button className="btn btn-danger btn-sm" onClick={() => removePart(p.id)}>删</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn btn-secondary btn-sm" data-testid="add-part" onClick={addPart}>＋ 加一行件</button>
          </section>

          <section className="nest-card">
            <h2>
              ② 能买到的整板规格
              <span className="nest-hint">如 1220×2440（4×8 尺），长边沿木纹</span>
            </h2>
            <div className="nest-presets">
              {PRESET_SPECS.map((preset, i) => (
                <button key={i} className="btn btn-sm" onClick={() => addPreset(preset)}>
                  ＋ {preset.name}
                </button>
              ))}
            </div>
            <table className="nest-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>长(顺纹)</th>
                  <th>宽</th>
                  <th>厚</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {batch.specs.map((s) => (
                  <tr key={s.id}>
                    <td><input className="nest-name-input" value={s.name} onChange={(e) => setSpec(s.id, { name: e.target.value })} /></td>
                    <td><input type="number" min={1} value={s.length} onChange={(e) => setSpec(s.id, { length: Number(e.target.value) })} /></td>
                    <td><input type="number" min={1} value={s.width} onChange={(e) => setSpec(s.id, { width: Number(e.target.value) })} /></td>
                    <td><input type="number" min={1} value={s.thickness} onChange={(e) => setSpec(s.id, { thickness: Number(e.target.value) })} /></td>
                    <td><button className="btn btn-danger btn-sm" onClick={() => removeSpec(s.id)}>删</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn btn-secondary btn-sm" onClick={addSpec}>＋ 自定义规格</button>
          </section>

          <section className="nest-card">
            <h2>
              ③ 手上已有的板（优先用，先开的先消耗）
              <span className="nest-hint">开过的板自动不吃四边毛边余量</span>
            </h2>
            <table className="nest-table">
              <thead>
                <tr>
                  <th>来源</th>
                  <th>备注</th>
                  <th>长</th>
                  <th>宽</th>
                  <th>厚</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {batch.stock.map((k) => (
                  <tr key={k.id}>
                    <td>
                      <select value={k.source} onChange={(e) => setStock(k.id, { source: e.target.value as StockSheet['source'] })}>
                        <option value="opened">已开（余料板，最优先）</option>
                        <option value="uncut">未开整张</option>
                      </select>
                    </td>
                    <td><input className="nest-name-input" value={k.label ?? ''} onChange={(e) => setStock(k.id, { label: e.target.value })} /></td>
                    <td><input type="number" min={1} value={k.length} onChange={(e) => setStock(k.id, { length: Number(e.target.value) })} /></td>
                    <td><input type="number" min={1} value={k.width} onChange={(e) => setStock(k.id, { width: Number(e.target.value) })} /></td>
                    <td><input type="number" min={1} value={k.thickness} onChange={(e) => setStock(k.id, { thickness: Number(e.target.value) })} /></td>
                    <td><button className="btn btn-danger btn-sm" onClick={() => removeStock(k.id)}>删</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="nest-presets">
              <button className="btn btn-secondary btn-sm" onClick={() => addStock('opened')}>＋ 加开过的板</button>
              <button className="btn btn-secondary btn-sm" onClick={() => addStock('uncut')}>＋ 加未开整张</button>
            </div>
          </section>

          <section className="nest-card">
            <h2>④ 锯路与修边 / 木纹</h2>
            <div className="nest-settings">
              <label>
                锯路宽度 mm
                <input
                  type="number" min={0} step={0.5}
                  data-testid="set-kerf"
                  value={batch.settings.kerfMm}
                  onChange={(e) => setSettings({ kerfMm: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
              <label>
                单边修边 mm
                <input
                  type="number" min={0} step={0.5}
                  data-testid="set-trim"
                  value={batch.settings.trimMm}
                  onChange={(e) => setSettings({ trimMm: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
              <label>
                新板四边毛边 mm
                <input
                  type="number" min={0} step={0.5}
                  data-testid="set-edge"
                  value={batch.settings.edgeTrimMm}
                  onChange={(e) => setSettings({ edgeTrimMm: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
              <label>
                余料短边 ≥ mm 才留
                <input
                  type="number" min={0} step={10}
                  data-testid="set-remnant"
                  value={batch.settings.minRemnantMm}
                  onChange={(e) => setSettings({ minRemnantMm: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
              <label className="nest-check">
                <input
                  type="checkbox"
                  data-testid="set-rotate"
                  checked={batch.settings.allowRotate}
                  onChange={(e) => setSettings({ allowRotate: e.target.checked })}
                />
                允许把件转 90°（转了的会橙色标出、列入确认，不建议默认开）
              </label>
            </div>
            <p className="nest-hint">
              件与件净间距 = 锯路 {fmt01(batch.settings.kerfMm)} + 两侧修边 {fmt01(2 * batch.settings.trimMm)} =
              <strong> {fmt01(batch.settings.kerfMm + 2 * batch.settings.trimMm)}mm</strong>
            </p>
          </section>
        </div>

        {/* 右：结果 */}
        <div className="nest-results" data-testid="nest-results">
          <section className="nest-card nest-summary">
            <h2>排料结果 <span className="nest-hint" data-testid="nest-recalc">重排耗时 {ms.toFixed(2)}ms（改任意输入自动重排）</span></h2>
            <div className="nest-stat-grid">
              <div className="nest-stat">
                <strong data-testid="stat-newsheets">{newSheetQty}</strong>
                <span>需新购板（张）</span>
              </div>
              <div className="nest-stat">
                <strong>{result.sheets.length}</strong>
                <span>总共用板（含库存）</span>
              </div>
              <div className="nest-stat">
                <strong className={unplacedQty > 0 ? 'stat-bad' : 'stat-ok'} data-testid="stat-placed">
                  {placedQty}/{totalParts}
                </strong>
                <span>已排件数</span>
              </div>
              <div className="nest-stat">
                <strong>{(totalRemnantArea / 1e6).toFixed(2)}m²</strong>
                <span>可留整块余料</span>
              </div>
            </div>

            {result.warnings.length > 0 && (
              <div className="warnings" data-testid="nest-warnings">
                {result.warnings.map((w, i) => (
                  <p key={i}>· {w}</p>
                ))}
              </div>
            )}

            <div className="nest-export-row">
              <button
                className="btn btn-primary"
                data-testid="export-csv"
                disabled={result.sheets.length === 0 && result.unplaced.length === 0}
                onClick={() => downloadText(`${batch.title || '开料清单'}.csv`, buildCSV(batch), 'text/csv;charset=utf-8')}
              >
                导出 CSV 开料清单
              </button>
              <button
                className="btn btn-secondary"
                data-testid="export-txt"
                disabled={result.sheets.length === 0 && result.unplaced.length === 0}
                onClick={() => downloadText(`${batch.title || '开料单'}.txt`, buildTextReport({ ...batch, result }), 'text/plain;charset=utf-8')}
              >
                导出 TXT 开料单（打印照做）
              </button>
              <button
                className="btn btn-secondary"
                onClick={() =>
                  downloadText(`${batch.title || '批次'}.json`, exportBatchJSON({ ...batch, result }), 'application/json')
                }
              >
                导出批次 JSON
              </button>
            </div>

            {result.purchase.length > 0 && (
              <table className="tooth-table nest-purchase-table" data-testid="purchase-table">
                <thead>
                  <tr><th>买几张</th><th>规格</th><th>长×宽×厚 mm</th></tr>
                </thead>
                <tbody>
                  {result.purchase.map((p) => (
                    <tr key={p.specId}>
                      <td>× {p.qty}</td>
                      <td>{p.specName}</td>
                      <td>{fmt01(p.length)}×{fmt01(p.width)}×{fmt01(p.thickness)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {result.stats.length > 0 && (
              <table className="tooth-table">
                <thead>
                  <tr><th>板厚</th><th>件数(已排/共)</th><th>用板(新购)</th><th>面积利用率</th></tr>
                </thead>
                <tbody>
                  {result.stats.map((st) => (
                    <tr key={st.thickness}>
                      <td>{fmt01(st.thickness)}mm</td>
                      <td>{st.placedParts}/{st.totalParts}</td>
                      <td>{st.sheetCount}（{st.newSheetCount}）</td>
                      <td>{(st.utilization * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* 每张板 */}
          {result.sheets.map((s) => (
            <section className="nest-card nest-sheet-card" key={s.id} data-testid={`sheet-${s.no}`}>
              <h2>
                #{s.no} {s.kind === 'new' ? '【新购板】' : s.source === 'opened' ? '【已开余料板·优先消耗】' : '【库存整张】'}
                {s.specName} {fmt01(s.length)}×{fmt01(s.width)}×{fmt01(s.thickness)}mm
              </h2>
              <div className="nest-sheet-body">
                <SheetSvg sheet={s} />
                <div className="nest-sheet-side">
                  <table className="tooth-table">
                    <thead>
                      <tr><th>件</th><th>成品尺寸</th><th>数量</th><th>木纹</th></tr>
                    </thead>
                    <tbody>
                      {groupPlacements(s.placements).map((g, i) => (
                        <tr key={i} className={g.rotated ? 'row-rotated' : ''}>
                          <td>{g.name}</td>
                          <td>{fmt01(g.alongLength)}×{fmt01(g.alongWidth)}</td>
                          <td>{g.qty}</td>
                          <td>{g.rotated ? '★转90° 待确认' : '顺纹'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {s.remnants.length > 0 && (
                    <div className="nest-remnant-list">
                      <strong>整块可留余料：</strong>
                      <ul>
                        {s.remnants.map((r, i) => (
                          <li key={i}>{fmt01(r.length)}×{fmt01(r.width)}mm（{(r.area / 1e6).toFixed(3)}m²）</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <p className="nest-hint">
                    碎料/锯路损耗：{(s.wasteArea / 1e6).toFixed(3)}m²
                  </p>
                </div>
              </div>
            </section>
          ))}

          {/* 摆不下的件 */}
          <section className="nest-card nest-unplaced" data-testid="unplaced-section">
            <h2>摆不下的件（{unplacedQty}）—— 不会被丢掉，需单独处理</h2>
            {result.unplaced.length === 0 ? (
              <p className="ok">全部排下了。</p>
            ) : (
              <table className="tooth-table">
                <thead>
                  <tr><th>件</th><th>尺寸</th><th>数量</th><th>原因</th></tr>
                </thead>
                <tbody>
                  {result.unplaced.map((u) => (
                    <tr key={u.partId}>
                      <td>{u.name}</td>
                      <td>{fmt01(u.length)}×{fmt01(u.width)}×{fmt01(u.thickness)}mm</td>
                      <td>{u.qty}</td>
                      <td className="nest-reason">{u.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function groupPlacements(placements: { partId: string; name: string; alongLength: number; alongWidth: number; rotated: boolean }[]) {
  const map = new Map<string, { name: string; alongLength: number; alongWidth: number; rotated: boolean; qty: number }>()
  for (const p of placements) {
    const key = p.partId + (p.rotated ? '|r' : '')
    const g = map.get(key)
    if (g) g.qty += 1
    else map.set(key, { name: p.name, alongLength: p.alongLength, alongWidth: p.alongWidth, rotated: p.rotated, qty: 1 })
  }
  return [...map.values()]
}
