/** Динамика одного показателя по дням.
 *
 *  Малые кратные, а не один график с несколькими линиями, и это не вкус:
 *  метрики бывают пятибалльные и десятибалльные, а класть разные шкалы на одну
 *  ось нельзя — сравнение выйдет ложным. По одному показателю на панель.
 *
 *  Следствие приятное: серия одна, значит легенда не нужна (её роль играет
 *  заголовок панели), а цвет линии ничего не кодирует. Поэтому он один на все
 *  панели и намеренно не из набора состояний: зелёная линия читалась бы как
 *  «хорошая метрика», а розовая — как «на неё можно нажать».
 */
import { useEffect, useRef, useState } from "react";

/** Синий проверен скриптом валидации палитры на белой подложке:
 *  светлота в полосе, насыщенность выше порога, контраст ≥ 3:1. */
const DATA = "#2a78d6";

export interface TrendDatum {
  date: string;
  value: number | null;
}

interface Props {
  title: string;
  points: TrendDatum[];
  /** Верх шкалы: 10 для десятибалльной метрики, 100 для процентов. */
  max: number;
  /** Подпись значения — балл, процент или сумма. */
  format: (value: number) => string;
}

const PAD = { top: 14, right: 12, bottom: 22, left: 32 };
const HEIGHT = 148;

/** Ширина берётся у контейнера, а не подгоняется viewBox: при растяжении
 *  viewBox поплыли бы толщины линий и радиусы точек. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  const months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  return `${d} ${months[(m ?? 1) - 1] ?? ""}`;
}

export function TrendChart({ title, points, max, format }: Props) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);

  const data = points.filter((p) => p.value != null) as { date: string; value: number }[];

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  // Ось X — время, а не порядковый номер: если смен не было три дня, разрыв
  // должен быть виден как разрыв, а не съехать в ровный шаг.
  const times = data.map((p) => new Date(`${p.date}T00:00:00`).getTime());
  const minT = times.length ? Math.min(...times) : 0;
  const maxT = times.length ? Math.max(...times) : 1;
  const spanT = maxT - minT || 1;

  const x = (i: number) =>
    data.length === 1 ? PAD.left + plotW / 2 : PAD.left + ((times[i] - minT) / spanT) * plotW;
  // Шкала всегда от нуля: обрезанная ось раздувает мелкие колебания оценок.
  const y = (v: number) => PAD.top + plotH - (Math.max(0, Math.min(max, v)) / max) * plotH;

  const line = data.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area =
    data.length > 1
      ? `${line} L${x(data.length - 1).toFixed(1)},${PAD.top + plotH} L${x(0).toFixed(1)},${PAD.top + plotH} Z`
      : "";

  const last = data[data.length - 1];
  const active = hover != null ? data[hover] : null;

  const pick = (clientX: number, rect: DOMRect) => {
    if (!data.length) return;
    const px = clientX - rect.left;
    let best = 0;
    for (let i = 1; i < data.length; i++) {
      if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    }
    setHover(best);
  };

  return (
    <figure className="chart" ref={ref}>
      <figcaption className="chart-title">{title}</figcaption>

      {data.length === 0 ? (
        <div className="chart-empty">за период нет данных</div>
      ) : (
        <div className="chart-plot">
          <svg width={width || 300} height={HEIGHT} role="img" aria-label={title}>
            {/* Сетка: три линии, волосяные, сплошные — они фон, а не данные */}
            {[0, 0.5, 1].map((f) => (
              <line
                key={f}
                className="chart-grid"
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={PAD.top + plotH * f}
                y2={PAD.top + plotH * f}
              />
            ))}
            {[max, max / 2, 0].map((v, i) => (
              <text key={v} className="chart-tick" x={PAD.left - 7} y={PAD.top + plotH * i * 0.5 + 4} textAnchor="end">
                {Number.isInteger(v) ? v : v.toFixed(0)}
              </text>
            ))}

            {area && <path d={area} fill={DATA} opacity={0.1} />}
            {data.length > 1 && (
              <path d={line} fill="none" stroke={DATA} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            )}

            {data.map((p, i) => (
              <circle
                key={p.date}
                cx={x(i)}
                cy={y(p.value)}
                r={hover === i ? 5 : 4}
                fill={DATA}
                /* Кольцо цветом подложки, а не обводка: точки остаются
                   различимы там, где налезают на линию и друг на друга. */
                stroke="#fff"
                strokeWidth={2}
              />
            ))}

            <text className="chart-date" x={PAD.left} y={HEIGHT - 6}>
              {shortDate(data[0].date)}
            </text>
            {data.length > 1 && (
              <text className="chart-date" x={PAD.left + plotW} y={HEIGHT - 6} textAnchor="end">
                {shortDate(last.date)}
              </text>
            )}

            {/* Прозрачная накладка ловит курсор по всей площади: попадать
                мышью в точку радиусом четыре пикселя невозможно. */}
            <rect
              x={PAD.left - 8}
              y={0}
              width={plotW + 16}
              height={HEIGHT}
              fill="transparent"
              onMouseMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
              onMouseLeave={() => setHover(null)}
            />
          </svg>

          {/* Значение последнего дня подписано всегда, остальные — по наведению:
              число над каждой точкой превращает панель в мусор. */}
          <div className="chart-last">{format(last.value)}</div>

          {active && (
            <div
              className="chart-tip"
              style={{ left: `${Math.min(Math.max(x(hover ?? 0), 40), (width || 300) - 40)}px` }}
            >
              <b>{format(active.value)}</b>
              <span>{shortDate(active.date)}</span>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
