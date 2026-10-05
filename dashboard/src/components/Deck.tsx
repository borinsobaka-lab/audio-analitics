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
  /** Свежая ссылка на аудио. Ссылка временная (час): у отчёта, открытого с
   *  утра, перемотка в новое место после обеда молча ломалась. */
  refreshSrc?: () => Promise<string>;
}

/** Умеет ли этот браузер играть Ogg Opus — формат, в котором лежит смена.
 *  Safari не умеет; без подсказки кнопки ▶ выглядят сломанными. */
export function canPlayRecording(): boolean {
  if (typeof document === "undefined") return true;
  const probe = document.createElement("audio");
  return probe.canPlayType("audio/ogg; codecs=opus") !== "";
}

const LEGEND: [string, string][] = [
  ["sale", "продажа"],
  ["consultation", "консультация"],
  ["refusal", "отказ"],
  ["service", "сервис"],
];

export const Deck = forwardRef<DeckHandle, Props>(function Deck(
  { src, dialogs, totalDuration, refreshSrc },
  ref
) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const lastRefresh = useRef(0);
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
    // Ссылка протухла (403 на перемотке) или сеть моргнула: берём новую
    // ссылку и возвращаемся на то же место. Не чаще раза в полминуты, чтобы
    // настоящая ошибка не превратилась в бесконечный цикл запросов.
    const onError = async () => {
      if (!refreshSrc) return;
      const now = Date.now();
      if (now - lastRefresh.current < 30_000) return;
      lastRefresh.current = now;
      const at = pendingSeek.current ?? el.currentTime;
      const wasPlaying = !el.paused;
      try {
        el.src = await refreshSrc();
        pendingSeek.current = at;
        el.load();
        if (wasPlaying) el.play().catch(() => {});
      } catch {
        /* следующая попытка — по следующей ошибке */
      }
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
      el.removeEventListener("error", onError);
    };
  }, [refreshSrc]);

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
        </div>
        {/* Головка живёт над дорожкой, а не внутри неё: у дорожки обрезка по
            краям, и кружок-ручка на нуле и в конце срезался бы пополам. */}
        <span className="tape-play" style={{ left: `${pct(time)}%` }} />
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
