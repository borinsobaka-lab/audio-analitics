/** Переключатель периода для статистики: готовые отрезки и две даты. */
import { DateField } from "../components/ui";
import { Slider } from "../components/Slider";
import { activePreset, daysAgo, Period, PERIOD_PRESETS } from "./period";

export default function PeriodFilter({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const preset = activePreset(value);
  return (
    <>
      <Slider className="seg" active={preset} role="group" aria-label="Период">
        {PERIOD_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`seg-btn${preset === p.key ? " on" : ""}`}
            onClick={() => onChange({ from: p.from(), to: daysAgo(0) })}
          >
            {p.label}
          </button>
        ))}
      </Slider>
      <span className="stats-range">
        <DateField value={value.from} max={value.to || undefined} onChange={(from) => onChange({ ...value, from })} aria-label="С даты" />
        <span className="muted">—</span>
        <DateField value={value.to} min={value.from || undefined} onChange={(to) => onChange({ ...value, to })} aria-label="По дату" />
      </span>
    </>
  );
}
