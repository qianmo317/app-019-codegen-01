// 单张板的排料板图：件框、木纹方向、旋转警示、余料块
import type { UsedStock } from './types'

interface Props {
  sheet: UsedStock
  maxPx?: number
}

export function SheetSvg({ sheet, maxPx = 520 }: Props) {
  const scale = Math.min(maxPx / sheet.width, 640 / sheet.length)
  const W = sheet.width * scale
  const H = sheet.length * scale

  return (
    <svg
      className="nest-svg"
      data-testid={`sheet-svg-${sheet.sheetNo}`}
      viewBox={`0 0 ${sheet.width} ${sheet.length}`}
      style={{ width: W, height: H }}
    >
      <rect x={0} y={0} width={sheet.width} height={sheet.length} className="sheet-border" />
      {/* 修边区 */}
      <rect
        x={10}
        y={10}
        width={Math.max(0, sheet.width - 20)}
        height={Math.max(0, sheet.length - 20)}
        className="trim-zone"
      />

      {sheet.remnants.map((r, i) => (
        <g key={`r${i}`} className="remnant">
          <rect x={r.x} y={r.y} width={r.w} height={r.h} className="remnant-rect" />
          <text x={r.x + 4} y={r.y + 14} className="remnant-text">
            余料 {fmt(r.w)}×{fmt(r.h)}
          </text>
        </g>
      ))}

      {sheet.placements.map((p, i) => (
        <g key={`p${i}`} className={p.rotated ? 'placement rotated' : 'placement'}>
          <rect x={p.x} y={p.y} width={p.w} height={p.h} className="part-rect" />
          {p.rotated && (
            <line x1={p.x} y1={p.y} x2={p.x + p.w} y2={p.y + p.h} className="rotate-mark" />
          )}
          <text
            x={p.x + p.w / 2}
            y={p.y + p.h / 2}
            className="part-label"
            transform={p.w < 70 || p.h < 60 ? `rotate(-90 ${p.x + p.w / 2} ${p.y + p.h / 2})` : undefined}
          >
            {p.name} #{p.qtyIndex}
          </text>
          <text x={p.x + 3} y={p.y + p.h - 3} className="part-size">
            {fmt(p.w)}×{fmt(p.h)}
            {p.rotated ? ' 转!' : ''}
          </text>
        </g>
      ))}

      <text x={4} y={14} className="sheet-size">
        {fmt(sheet.width)}×{fmt(sheet.length)} t{fmt(sheet.thickness)}
      </text>
    </svg>
  )
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
