/** Общие элементы админки: огонёк статуса, шкала оценки, пустые состояния,
 *  иконки. Всё на своих CSS-классах из styles.css — без внешних зависимостей. */
import { ReactNode } from "react";

/* --- Иконки: один штрих 1.5px, размер 16 — набор держится единым. -------- */

type IconProps = { size?: number };
const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const IconDays = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="3" y="5" width="18" height="16" rx="2.5" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </svg>
);

export const IconDashboard = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 17a9 9 0 0 1 18 0" />
    <path d="M12 17l4.5-5" />
    <path d="M3 17h2M19 17h2M12 8V6" />
  </svg>
);

export const IconMetrics = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 19V9M10 19V5M16 19v-6M22 19H2" />
  </svg>
);

export const IconPeople = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20" />
    <circle cx="9.5" cy="7" r="3.2" />
    <path d="M21 20v-1.5a4 4 0 0 0-3-3.87" />
  </svg>
);

export const IconWave = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M5 10v4M9 6v12M13 8.5v7M17 4.5v15" />
  </svg>
);

export const IconPlay = ({ size = 14 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5.2a1 1 0 0 1 1.53-.85l9.1 5.8a1 1 0 0 1 0 1.7l-9.1 5.8A1 1 0 0 1 8 16.8Z" />
  </svg>
);

export const IconPause = ({ size = 14 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <rect x="6.5" y="5" width="4" height="14" rx="1.3" />
    <rect x="13.5" y="5" width="4" height="14" rx="1.3" />
  </svg>
);

/* --- Статус ------------------------------------------------------------- */

const STATUS_LABELS: Record<string, string> = {
  recording: "Идёт запись",
  uploaded: "В очереди",
  processing: "Обрабатывается",
  done: "Готово",
  error: "Ошибка",
};

const KNOWN = ["recording", "uploaded", "processing", "done", "error"];

export function StatusLight({ status }: { status: string }) {
  const cls = KNOWN.includes(status) ? status : "";
  return (
    <span className={`status ${cls}`}>
      <span className="dot" />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

/* --- Оценка ------------------------------------------------------------- */

/** Зона оценки одним словом. Порог один на весь интерфейс: полосы, цифры в
 *  чипах и всё, что появится позже, должны краснеть в один и тот же момент. */
export function scoreZone(score: number, scale: number): "low" | "mid" | "good" {
  const ratio = Math.max(0, Math.min(1, score / scale));
  return ratio < 0.5 ? "low" : ratio < 0.7 ? "mid" : "good";
}

/** Полоса из `scale` сегментов: цвет отвечает «хорошо или плохо» до того, как
 *  прочитана цифра. Зона берётся от точного значения, а закрашиваются целые
 *  сегменты — средняя 7.3 даёт семь зелёных, а не «почти зелёных». */
export function ScoreBar({ score, scale }: { score: number; scale: number }) {
  const zone = scoreZone(score, scale);
  const filled = Math.round(score);
  return (
    <span className="score-bar" aria-hidden>
      {Array.from({ length: scale }, (_, i) => (
        <i key={i} className={`score-seg ${i < filled ? `on ${zone}` : ""}`} />
      ))}
    </span>
  );
}

/** Оценка целиком: цифра плюс полоса. Сегментная шкала вместо звёзд — на
 *  десятибалльной шкале десять звёзд шум, а десять сегментов читаются
 *  одним взглядом. */
export function Score({ score, scale }: { score: number; scale: number }) {
  return (
    <span className="score" title={`${score} из ${scale}`}>
      <span className="score-val">
        {score}
        <span className="of">/{scale}</span>
      </span>
      <ScoreBar score={score} scale={scale} />
    </span>
  );
}

/* --- Блоки страницы ----------------------------------------------------- */

export function PageHead({
  title,
  hint,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="grow">
        <h1 className="display">{title}</h1>
        {hint && <p>{hint}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </header>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <h4>{title}</h4>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Note({
  kind,
  children,
}: {
  kind: "error" | "success" | "info";
  children: ReactNode;
}) {
  return <div className={`note ${kind}`}>{children}</div>;
}

export function Skeleton({ height = 68, count = 3 }: { height?: number; count?: number }) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}
