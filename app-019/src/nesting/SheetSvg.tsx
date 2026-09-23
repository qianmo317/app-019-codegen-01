// 单张板排料图：真实坐标比例渲染；木纹顺向画细线，旋转件橙色高亮，余料虚线绿框
import type { ResultSheet } from './types'
import { fmt01 } from '../lib/format'

const PAD = 18 // 板外留白（viewBox 单位 = mm）

export function SheetSvg({ sheet }: { sheet: ResultSheet }) {
  const W = sheet.length + PAD * 2
  const H = sheet.width + PAD * 2

  const labelFs = Math.min(14, Math.max(7, sheet.length / 45))
  const grainGap = 14

  return (
    <svg
      className="nest-svg"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`第 ${sheet.no} 张板排料图`}
    >
      {/* 板外框 */}
      <rect x={PAD} y={PAD} width={sheet.length} height={sheet.width} className="nest-board" />

      {/* 木纹底色（顺板长方向，提示木纹基准） */}
      <g className="nest-grain">
        {Array.from({ length: Math.floor(sheet.width / grainGap) }, (_, i) => {
          const y = PAD + (i + 1) * grainGap
          return <line key={i} x1={PAD + 4} y1={y} x2={PAD + sheet.length - 4} y2={y} />
        })}
      </g>

      {/* 余料：绿色虚线框 */}
      {sheet.remnants.map((r, i) => (
        <g key={`r${i}`} className="nest-remnant">
          <rect x={PAD + r.x} y={PAD + r.y} width={r.length} height={r.width} />
          <text x={PAD + r.x + 3} y={PAD + r.y + labelFs + 1} className="nest-remnant-text">
            余料 {fmt01(r.length)}×{fmt01(r.width)}
          </text>
        </g>
      ))}

      {/* 工件 */}
      {sheet.placements.map((p, i) => (
        <g key={i} className={p.rotated ? 'nest-piece nest-piece-rotated' : 'nest-piece'}>
          <rect x={PAD + p.x} y={PAD + p.y} width={p.alongLength} height={p.alongWidth} />
          {p.rotated && (
            <text
              x={PAD + p.x + 3}
              y={PAD + p.y + labelFs + 1}
              className="nest-piece-mark"
            >
              ★转90°
            </text>
          )}
          {(p.alongLength > 120 || p.alongWidth > 120) && (
            <text
              x={PAD + p.x + p.alongLength / 2}
              y={PAD + p.y + p.alongWidth / 2}
              textAnchor="middle"
              dominantBaseline="central"
              className="nest-piece-label"
            >
              {p.name}
            </text>
          )}
        </g>
      ))}

      {/* 板尺寸标注 */}
      <text x={PAD} y={PAD - 6} className="nest-board-label">
        {fmt01(sheet.length)} × {fmt01(sheet.width)} × {fmt01(sheet.thickness)}mm
      </text>
    </svg>
  )
}
