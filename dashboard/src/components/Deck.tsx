/** Дека: пульт прослушивания смены, закреплённый внизу отчёта.
 *
 *  Смена — это непрерывная плёнка на десять-двенадцать часов, в которой
 *  разговоры занимают считанные минуты. Лента показывает это буквально:
 *  часовые засечки, отрезки разговоров на своих местах и головка
 *  воспроизведения. Любая метка времени в тексте отчёта управляет этой декой,
 *  поэтому звук в интерфейсе ровно один и всегда под рукой.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Dialog, fmtTs } from "../api";
import { IconPause, IconPlay } from "./ui";

export interface DeckHandle {
  /** Перемотать к секунде и начать воспроизведение. */
  seek: (seconds: number) => void;
}

interface Props {
  src: string;
  dialogs: Dialog[];
  /** Длительность записи по данным сервера — известна до загрузки аудио. */
  totalDuration: number | null;
}

const LEGEND: [string, string][] = [
  ["sale", "продажа"],
  ["consultation", "консультация"],
  ["refusal", "отказ"],
  ["service", "сервис"],
];

export const Deck = forwardRef<DeckHandle, Props>(function Deck(
  { src, dialogs, totalDuration },
  ref
) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState<number | null>(null);

  const duration = loaded ?? totalDuration ?? 0;

  // Аудио грузится лениво (preload="none"), поэтому перемотка до загрузки
  // метаданных откладывается до события loadedmetadata.
  const applySeek = (seconds: number) => {
    const el = audioRef.current;
    if (!el) return;
    if (el.readyState === 0) {
      pendingSeek.current = seconds;
      el.load();
      return;
    }
    el.currentTime = seconds;
    setTime(seconds);
  };

  useImperativeHandle(ref, () => ({
    seek(seconds: number) {
      applySeek(seconds);
      audioRef.current?.play().catch(() => {});
    },
  }));

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setTime(el.currentTime);
    const onMeta = () => {
      if (Number.isFinite(el.duration)) setLoaded(el.duration);
      if (pendingSeek.current != null) {
        el.currentTime = pendingSeek.current;
        setTime(pendingSeek.current);
        pendingSeek.current = null;
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
    };
  }, []);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };

  const pct = (seconds: number) =>
    duration > 0 ? Math.min(100, (seconds / duration) * 100) : 0;

  const hours = duration > 0 ? Math.floor(duration / 3600) : 0;

  return (
    <div className="deck">
      <audio ref={audioRef} src={src} preload="none" />

      <button
        className={`deck-play ${playing ? "playing" : ""}`}
        onClick={toggle}
        aria-label={playing ? "Пауза" : "Слушать"}
        title={playing ? "Пауза" : "Слушать"}
      >
        {playing ? <IconPause size={15} /> : <IconPlay size={15} />}
      </button>

      <span className="deck-time">{fmtTs(time)}</span>

      <div className="tape">
        <div className="tape-track">
          {Array.from({ length: hours }, (_, i) => (
            <span
              key={i}
              className="tape-hour"
              style={{ left: `${pct((i + 1) * 3600)}%` }}
            />
          ))}
          {dialogs
            .filter((d) => d.type !== "irrelevant")
            .map((d) => (
              <span
                key={d.id}
                className={`tape-seg ${d.type}`}
                style={{
                  left: `${pct(d.start_s)}%`,
                  width: `${Math.max(0.35, pct(d.end_s) - pct(d.start_s))}%`,
                }}
              />
            ))}
          <span className="tape-play" style={{ left: `${pct(time)}%` }} />
        </div>
        {/* Настоящий range: перемотка стрелками и работа со скринридером
            достаются даром, а отрезки под ним остаются декорацией. */}
        <input
          className="tape-input"
          type="range"
          min={0}
          max={Math.max(1, Math.floor(duration))}
          step={1}
          value={Math.floor(time)}
          aria-label="Позиция в записи смены"
          onChange={(e) => applySeek(Number(e.target.value))}
        />
      </div>

      <span className="deck-time total">{duration ? fmtTs(duration) : "—"}</span>

      <div className="deck-legend">
        {LEGEND.map(([type, label]) => (
          <span key={type}>
            <i className={`tape-seg ${type}`} style={{ position: "static" }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
});
