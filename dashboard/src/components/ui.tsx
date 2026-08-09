/** Общие элементы админки: огонёк статуса, шкала оценки, пустые состояния,
 *  иконки. Всё на своих CSS-классах из styles.css — без внешних зависимостей. */
import { ReactNode, useState } from "react";

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

export const IconStudio = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 21V10.5L12 4l8 6.5V21" />
    <path d="M9.5 21v-5.5h5V21" />
  </svg>
);

export const IconApp = ({ size = 17 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="4" y="3" width="16" height="18" rx="2.5" />
    <path d="M12 8v6M9 11.5l3 3 3-3" />
  </svg>
);

export const IconCalendar = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="3" y="5" width="18" height="16" rx="2.5" />
    <path d="M3 10h18M8 3v4M16 3v4" />
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
  // Запись закончена, разбор не запускался: его включают вручную, чтобы не
  // платить за пустые дни, неудачные дубли и проверки оборудования.
  uploaded: "Ждёт разбора",
  queued: "В очереди",
  processing: "Обрабатывается",
  done: "Готово",
  error: "Ошибка",
};

const KNOWN = ["recording", "uploaded", "queued", "processing", "done", "error"];

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
 *  одним взглядом.
 *
 *  Цифра красится по той же зоне, что и полоса, — везде одинаково. Раньше на
 *  дашборде она была цветной, а в списке смен чернильной: одно и то же число
 *  выглядело по-разному в зависимости от того, на какой странице смотришь. */
export function Score({ score, scale }: { score: number; scale: number }) {
  return (
    <span className="score" title={`${score} из ${scale}`}>
      <span className={`score-val ${scoreZone(score, scale)}`}>
        {score}
        <span className="of">/{scale}</span>
      </span>
      <ScoreBar score={score} scale={scale} />
    </span>
  );
}

/* --- Дельта к прошлому периоду ------------------------------------------ */

/** Направление и оценка — разные каналы. Стрелка показывает, куда сдвинулось
 *  число; цвет — хорошо это или плохо. У расходов они расходятся: снижение
 *  затрат рисуется стрелкой вниз, но зелёным. */
export type DeltaValue = {
  text: string;
  dir: "up" | "down" | "flat";
  good: boolean | null;
} | null;

const ARROW = { up: "↑ ", down: "↓ ", flat: "" };

export function Delta({ value }: { value: DeltaValue }) {
  if (!value) return <span className="delta none">—</span>;
  const tone = value.good == null ? "flat" : value.good ? "up" : "down";
  return (
    <span className={`delta ${tone}`}>
      {ARROW[value.dir]}
      {value.text}
    </span>
  );
}

/* --- Показатель --------------------------------------------------------- */

/** Плитка показателя. Одна на весь проект: и итоги смены, и итоги периода —
 *  это одно и то же «крупная цифра + подпись», разошлись бы они только от
 *  того, что их писали в разных файлах. */
export function Stat({
  value,
  label,
  lead = false,
  delta,
  bar,
  title,
}: {
  value: ReactNode;
  label: ReactNode;
  lead?: boolean;
  delta?: DeltaValue;
  bar?: { score: number; scale: number };
  title?: string;
}) {
  return (
    <div className={`stat ${lead ? "lead" : ""}`} title={title}>
      <div className="v">{value}</div>
      {bar && <ScoreBar score={bar.score} scale={bar.scale} />}
      <div className="label">{label}</div>
      {delta !== undefined && <Delta value={delta} />}
    </div>
  );
}

/** Строка «оценка — название метрики»: колонка оценок фиксированной ширины,
 *  поэтому полосы и названия выравниваются между строками. */
export function MetricLine({
  name,
  score,
  scale,
  meta,
  delta,
  compact = false,
  emptyLabel = "не сработала",
}: {
  name: string;
  score: number | null;
  scale: number;
  meta?: ReactNode;
  delta?: DeltaValue;
  compact?: boolean;
  emptyLabel?: string;
}) {
  return (
    <div className={`metric-line ${compact ? "compact" : ""}`}>
      {score != null ? (
        <Score score={score} scale={scale} />
      ) : (
        <span className="score-empty">{emptyLabel}</span>
      )}
      <span className="metric-name">
        {name}
        {meta != null && <span className="times"> {meta}</span>}
        {delta !== undefined && <Delta value={delta} />}
      </span>
    </div>
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
  // Сообщение появляется после действия пользователя — без aria-live
  // скринридер о нём не узнает.
  return (
    <div className={`note ${kind}`} role="status" aria-live="polite">
      {children}
    </div>
  );
}

/* --- Секция, таблица, подтверждение, поле даты -------------------------- */

/** Заголовок раздела с необязательной поясняющей строкой. */
export function Section({
  title,
  hint,
  children,
}: {
  title?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="section">
      {title && (
        <div className="section-head">
          <h3>{title}</h3>
          {hint && <span className="count">{hint}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

/** Блок разбора на цветной подложке.
 *
 *  До этого выводы смены шли одним столбцом одинаковых списков, и «главные
 *  отклонения» приходилось искать глазами наравне с «удачными моментами».
 *  Подложка отвечает на «это хорошее или плохое» раньше, чем прочитан
 *  заголовок: красноватая — то, что провалено, зеленоватая — то, что вышло,
 *  серая — всё остальное, то есть рекомендации на будущее.
 *
 *  Цвета намеренно бледные (десятая доля непрозрачности): плашек на экране
 *  много, насыщенные превратили бы отчёт в светофор.
 */
export function Panel({
  tone,
  title,
  hint,
  children,
}: {
  tone: "bad" | "good" | "info" | "neutral";
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`panel ${tone}`}>
      <h4 className="panel-title">
        {title}
        {hint && <span className="panel-hint">{hint}</span>}
      </h4>
      {children}
    </section>
  );
}

export type Column = { label: string; num?: boolean; className?: string };

/** Таблица в карточке. Обёртка прокручивается по горизонтали: на узком экране
 *  лучше сдвинуть таблицу вбок, чем сжать колонку до двух символов. */
export function TableCard({
  columns,
  children,
}: {
  columns: Column[];
  children: ReactNode;
}) {
  return (
    <div className="sheet table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th
                key={i}
                scope="col"
                className={[c.num ? "num-col" : "", c.className ?? ""].join(" ").trim()}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Необратимое действие через второе нажатие. Нативный confirm() в этом
 *  проекте не используется: на macOS WebView он молча не показывается, и
 *  один раз это уже стоило нам неработающей кнопки. */
export function ConfirmAction({
  label,
  confirmLabel,
  title,
  onConfirm,
  disabled = false,
  small = false,
}: {
  label: string;
  confirmLabel: string;
  title?: string;
  onConfirm: () => void;
  disabled?: boolean;
  small?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const size = small ? " small" : "";
  if (!armed) {
    return (
      <button className={`ghost${size}`} title={title} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <>
      <button className={`danger${size}`} disabled={disabled} onClick={onConfirm}>
        {confirmLabel}
      </button>
      <button className={`ghost${size}`} onClick={() => setArmed(false)}>
        Отмена
      </button>
    </>
  );
}

/** Поле даты: оформление наше, поведение родное. Свой календарь — это
 *  клавиатурная навигация, ловушка фокуса, ARIA и колесо даты на телефоне;
 *  всё это уже есть в нативном поле, надо было только снять с него чужой вид. */
export function DateField({
  value,
  min,
  max,
  onChange,
  ...rest
}: {
  value: string;
  min?: string;
  max?: string;
  onChange: (value: string) => void;
  "aria-label": string;
}) {
  return (
    <span className="date-field">
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
      <IconCalendar size={14} />
    </span>
  );
}

export function Skeleton({ height = 68, count = 3 }: { height?: number; count?: number }) {
  return (
    <div className="skeleton-stack">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}
