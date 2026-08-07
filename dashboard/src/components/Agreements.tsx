/** Договорённости по итогам разбора.
 *
 *  Разбор, после которого ничего не записано, забывается к вечеру. Здесь
 *  фиксируется, о чём условились с менеджером после конкретной смены — при
 *  желании со ссылкой на разговор, из-за которого разговор и зашёл.
 *
 *  Дальше работает главное: в карточке следующей смены того же менеджера
 *  незакрытые договорённости показываются сверху с вопросом «сделали?».
 *  Никто не должен помнить о проверке — она сама всплывает в нужный день.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Agreement, api, Dialog, fmtDate, fmtTs } from "../api";
import { Panel } from "./ui";

const STATUS_LABEL: Record<string, string> = {
  open: "Ждёт проверки",
  done: "Выполнено",
  missed: "Не выполнено",
  cancelled: "Снято",
};

const STATUS_PILL: Record<string, string> = {
  open: "consultation",
  done: "sale",
  missed: "refusal",
  cancelled: "irrelevant",
};

function dayLabel(iso: string): string {
  const { day } = fmtDate(iso);
  return day;
}

/** Договорённости с прошлых смен этого менеджера — то, ради чего всё и
 *  затевалось. Стоит выше итогов дня: разбор начинается с проверки того, о
 *  чём договорились в прошлый раз. */
export function CarriedAgreements({
  items,
  currentDayId,
  canManage,
  onChanged,
}: {
  items: Agreement[];
  currentDayId: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <Panel
      tone="neutral"
      title="С прошлой смены"
      hint="о чём договорились в прошлый раз — проверьте перед разбором"
    >
      <div className="agreements">
        {items.map((a) => (
          <CarriedRow
            key={a.id}
            agreement={a}
            currentDayId={currentDayId}
            canManage={canManage}
            onChanged={onChanged}
          />
        ))}
      </div>
    </Panel>
  );
}

function CarriedRow({
  agreement,
  currentDayId,
  canManage,
  onChanged,
}: {
  agreement: Agreement;
  currentDayId: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const mark = async (status: "done" | "missed" | "cancelled") => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.updateAgreement(agreement.id, {
        status,
        // Ссылка на смену, где отметили: из карточки договорённости видно не
        // только «выполнено», но и когда это проверили.
        resolved_day_recording_id: currentDayId,
      });
      onChanged();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
      setBusy(false);
    }
  };

  return (
    <div className="agreement">
      <div className="agreement-text">{agreement.text}</div>
      <div className="agreement-meta">
        <Link to={`/days/${agreement.day_recording_id}`}>
          смена {dayLabel(agreement.day_date)}
        </Link>
        {agreement.dialog_start_s != null && (
          <span> · разговор {fmtTs(agreement.dialog_start_s)}</span>
        )}
        {agreement.created_by_name && <span> · {agreement.created_by_name}</span>}
      </div>
      {canManage && (
        <div className="actions end">
          <button className="small" disabled={busy} onClick={() => mark("done")}>
            Выполнено
          </button>
          <button
            className="ghost small"
            disabled={busy}
            onClick={() => mark("missed")}
          >
            Не выполнено
          </button>
          <button
            className="ghost small"
            disabled={busy}
            title="Договорённость потеряла смысл"
            onClick={() => mark("cancelled")}
          >
            Снять
          </button>
        </div>
      )}
      {error && <span className="feedback-error">{error}</span>}
    </div>
  );
}

/** Договорённости, записанные по итогам этой смены. */
export function DayAgreements({
  items,
  dayId,
  dialogs,
  canManage,
  onChanged,
}: {
  items: Agreement[];
  dayId: string;
  dialogs: Dialog[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [text, setText] = useState("");
  const [dialogId, setDialogId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const add = async () => {
    if (text.trim().length < 3 || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.createAgreement({
        day_recording_id: dayId,
        dialog_id: dialogId || null,
        text: text.trim(),
      });
      setText("");
      setDialogId("");
      onChanged();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteAgreement(id);
      onChanged();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    }
  };

  return (
    <div className="sheet sheet-pad">
      <div className="agreements">
        {items.length === 0 && (
          <p className="muted no-margin">
            Пока ничего не записано. Договорённость — это одна конкретная вещь,
            которую менеджер сделает в следующую смену; она сама всплывёт в
            карточке того дня.
          </p>
        )}
        {items.map((a) => (
          <div key={a.id} className={`agreement ${a.status}`}>
            <div className="agreement-text">
              <span className={`pill ${STATUS_PILL[a.status] ?? ""}`}>
                {STATUS_LABEL[a.status] ?? a.status}
              </span>{" "}
              {a.text}
            </div>
            <div className="agreement-meta">
              {a.created_by_name && <span>записал {a.created_by_name}</span>}
              {a.dialog_start_s != null && (
                <span> · разговор {fmtTs(a.dialog_start_s)}</span>
              )}
              {a.resolved_day_recording_id && (
                <>
                  {" · отмечено на "}
                  <Link to={`/days/${a.resolved_day_recording_id}`}>
                    следующей смене
                  </Link>
                </>
              )}
              {a.resolved_by_name && <span> · {a.resolved_by_name}</span>}
            </div>
            {canManage && a.status === "open" && (
              <div className="actions end">
                <button className="ghost small" onClick={() => remove(a.id)}>
                  Удалить
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="field-row agreement-form">
        <label className="field field-grow">
          <span className="label">О чём договорились</span>
          <input
            type="text"
            value={text}
            placeholder="Например: в каждом разговоре спрашивать про цель занятий"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        </label>
        {dialogs.length > 0 && (
          <label className="field">
            <span className="label">По разговору</span>
            <select value={dialogId} onChange={(e) => setDialogId(e.target.value)}>
              <option value="">не привязывать</option>
              {dialogs.map((d, i) => (
                <option key={d.id} value={d.id}>
                  {i + 1} · {fmtTs(d.start_s)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button onClick={add} disabled={busy || text.trim().length < 3}>
          Записать
        </button>
      </div>

      {error && <span className="feedback-error">{error}</span>}
    </div>
  );
}
