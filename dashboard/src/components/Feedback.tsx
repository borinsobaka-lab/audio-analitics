/** «Согласен / не согласен» с оценкой разговора.
 *
 *  Зачем это в продукте. Разбор делает модель, а работает по нему человек, и
 *  если оценка кажется несправедливой, у человека должен быть способ это
 *  сказать — иначе разбор превращается в приговор, который слушают молча.
 *  Кнопка стоит там же, где оценка, и не требует ничего писать: одно нажатие.
 *
 *  Голос всегда относится к конкретной оценке — общего «согласен с разбором
 *  разговора» нет: возражение «вообще» нечем починить.
 *
 *  Одновременно это единственный честный источник данных о качестве самих
 *  промптов. Несогласия копятся в разделе «Метрики и анализ» в разрезе
 *  метрики: если одна и та же метрика вызывает возражения на разных сменах у
 *  разных людей, дело не в людях, а в формулировке.
 */
import { useState } from "react";
import { api, DialogFeedback, plural } from "../api";

interface Props {
  dialogId: string;
  metricId: string;
  items: DialogFeedback[];
  onChanged: (items: DialogFeedback[]) => void;
  label?: string;
}

function sameTarget(f: DialogFeedback, dialogId: string, metricId: string) {
  return f.dialog_id === dialogId && f.metric_id === metricId;
}

export function FeedbackControl({
  dialogId,
  metricId,
  items,
  onChanged,
  label = "Оценка справедлива?",
}: Props) {
  const target = items.filter((f) => sameTarget(f, dialogId, metricId));
  const mine = target.find((f) => f.is_mine) ?? null;
  const others = target.filter((f) => !f.is_mine);
  const otherDisagree = others.filter((f) => !f.agree).length;

  const [comment, setComment] = useState(mine?.comment ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const replace = (row: DialogFeedback | null, removedId?: string) => {
    const rest = items.filter((f) =>
      removedId ? f.id !== removedId : !(f.is_mine && sameTarget(f, dialogId, metricId))
    );
    onChanged(row ? [...rest, row] : rest);
  };

  const vote = async (agree: boolean) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      // Повторное нажатие по уже выбранному — это «беру слова назад»:
      // отзыв должно быть так же легко снять, как оставить.
      if (mine && mine.agree === agree) {
        await api.withdrawFeedback(mine.id);
        setComment("");
        replace(null, mine.id);
      } else {
        const row = await api.leaveFeedback({
          dialog_id: dialogId,
          metric_id: metricId,
          agree,
          comment: agree ? "" : comment,
        });
        replace(row);
      }
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const saveComment = async () => {
    if (busy || !mine) return;
    setBusy(true);
    setError("");
    try {
      replace(
        await api.leaveFeedback({
          dialog_id: dialogId,
          metric_id: metricId,
          agree: false,
          comment,
        })
      );
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="feedback">
      <div className="feedback-row">
        <span className="feedback-label">{label}</span>
        <button
          className={`vote ${mine?.agree === true ? "on agree" : ""}`}
          disabled={busy}
          onClick={() => vote(true)}
        >
          Согласен
        </button>
        <button
          className={`vote ${mine?.agree === false ? "on disagree" : ""}`}
          disabled={busy}
          onClick={() => vote(false)}
        >
          Не согласен
        </button>
        {otherDisagree > 0 && (
          <span className="feedback-others">
            ещё {otherDisagree}{" "}
            {plural(otherDisagree, "несогласие", "несогласия", "несогласий")}
          </span>
        )}
      </div>

      {/* Комментарий спрашивается только у несогласия: согласие ничего не
          объясняет, а лишнее поле под каждой оценкой — это шум. */}
      {mine && !mine.agree && (
        <div className="feedback-why">
          <input
            type="text"
            value={comment}
            placeholder="Что именно не так? Увидит владелец при правке промпта"
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveComment()}
          />
          {comment !== (mine.comment ?? "") && (
            <button className="secondary small" disabled={busy} onClick={saveComment}>
              Сохранить
            </button>
          )}
        </div>
      )}

      {others.length > 0 && (
        <ul className="feedback-list">
          {others.map((f) => (
            <li key={f.id}>
              <b className={f.agree ? "agree" : "disagree"}>
                {f.agree ? "согласен" : "не согласен"}
              </b>{" "}
              — {f.author_name || "сотрудник"}
              {f.comment && <span className="feedback-note">: {f.comment}</span>}
            </li>
          ))}
        </ul>
      )}

      {error && <span className="feedback-error">{error}</span>}
    </div>
  );
}
