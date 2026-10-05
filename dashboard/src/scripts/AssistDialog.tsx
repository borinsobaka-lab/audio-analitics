/** ИИ-помощник: администратор вставляет сообщение клиента, ИИ подбирает
 *  подходящие скрипты — или, если подходящего нет, пишет ответ сам.
 *
 *  Найденные скрипты показываются здесь же, текстами на языке клиента и с
 *  «Копировать» — открывать скрипт не нужно. Написанный ИИ ответ можно
 *  поправить прямо в поле перед копированием.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, AssistResult, ScriptItem, ScriptLang, ScriptSection } from "../api";
import { Note } from "../components/ui";
import { langInfo, messageText, pickVariant, resolveText, VarResolver } from "./logic";
import { CopyButton } from "./ScriptCard";
import RichText from "./RichText";

const IconSparkle = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5z" />
    <path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8L19 15z" opacity="0.7" />
  </svg>
);
export { IconSparkle };

function MatchCard({
  item,
  section,
  why,
  lang,
  studio,
  resolveVar,
  onOpen,
}: {
  item: ScriptItem;
  section: ScriptSection;
  why: string;
  lang: ScriptLang;
  studio: string;
  resolveVar: VarResolver;
  onOpen: () => void;
}) {
  const variant = pickVariant(item, studio);
  return (
    <article className="assist-match">
      <header className="assist-match-head">
        <button type="button" className="assist-match-title" onClick={onOpen} title="Открыть скрипт">
          {item.title}
        </button>
        <span className="assist-match-section">{section.title}</span>
      </header>
      {why && <p className="assist-why">{why}</p>}
      {variant.messages.map((m, i) => {
        const shown = messageText(m, lang);
        return (
          <div className="assist-msg" key={i}>
            <div className="assist-msg-head">
              <span className="assist-msg-label">
                {m.label || (variant.messages.length > 1 ? `Сообщение ${i + 1}` : "Текст")}
              </span>
              <CopyButton
                text={resolveText(shown.text, resolveVar)}
                onCopied={() =>
                  api
                    .logCopy({ item_id: item.id, lang: shown.lang, studio: variant.label || studio, source: "assist" })
                    .catch(() => {})
                }
              />
            </div>
            {shown.fallback && (
              <p className="script-missing">
                Текста на {langInfo(lang).inName} нет — показан {langInfo(shown.lang).name}.
              </p>
            )}
            <div className="script-text" lang={shown.lang}>
              <RichText text={shown.text} terms={[]} resolveVar={resolveVar} />
            </div>
          </div>
        );
      })}
    </article>
  );
}

export default function AssistDialog({
  sections,
  lang,
  studio,
  resolverFor,
  onOpen,
  onClose,
}: {
  sections: ScriptSection[];
  /** Язык, выбранный вверху скриптов, — подсказка ИИ. */
  lang: ScriptLang;
  studio: string;
  /** Подстановка переменных на языке ответа (он может отличаться от выбранного). */
  resolverFor: (lang: ScriptLang) => VarResolver;
  onOpen: (item: ScriptItem, section: ScriptSection) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AssistResult | null>(null);
  const [reply, setReply] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    field.current?.focus();
  }, []);

  const answerLang = result?.language ?? lang;
  const resolveVar = useMemo(() => resolverFor(answerLang), [resolverFor, answerLang]);

  const matches = useMemo(() => {
    if (!result) return [];
    const out: { item: ScriptItem; section: ScriptSection; why: string }[] = [];
    for (const m of result.matches)
      for (const sec of sections) {
        const item = sec.items.find((i) => i.id === m.item_id);
        if (item) out.push({ item, section: sec, why: m.why });
      }
    return out;
  }, [result, sections]);

  async function ask() {
    const text = message.trim();
    if (text.length < 2 || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await api.assist({ message: text, lang, studio });
      setResult(res);
      // Переменные в ответе ИИ ({админ}, {студия}…) подставляются сразу —
      // в поле уже готовый текст, его можно править.
      setReply(resolveText(res.reply, resolverFor(res.language)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="modal modal-wide"
      aria-labelledby="assist-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current && !busy) ref.current?.close();
      }}
    >
      <div className="modal-head">
        <div>
          <h2 id="assist-title" className="assist-title">
            <span className="assist-icon"><IconSparkle size={18} /></span>
            ИИ-помощник
          </h2>
          <p className="muted">
            Вставьте сообщение клиента — подберу скрипт, а если подходящего нет, напишу ответ.
          </p>
        </div>
        <button type="button" className="ghost small icon-btn" aria-label="Закрыть"
          onClick={() => ref.current?.close()}>
          ✕
        </button>
      </div>

      <div className="modal-body">
        <form
          className="assist-ask"
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
        >
          <label className="field">
            <span className="label">Сообщение клиента</span>
            <textarea
              ref={field}
              rows={4}
              maxLength={4000}
              value={message}
              placeholder="Например: «Здравствуйте, сколько стоит пробное и можно ли прийти завтра вечером?»"
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  ask();
                }
              }}
            />
          </label>
          <div className="assist-ask-foot">
            <span className="muted">Ctrl + Enter — подобрать</span>
            <button type="submit" disabled={busy || message.trim().length < 2}>
              {busy ? "Думаю…" : result ? "Подобрать заново" : "Подобрать ответ"}
            </button>
          </div>
        </form>

        {busy && (
          <div className="assist-busy" role="status">
            <span className="assist-spinner" aria-hidden="true" />
            Смотрю скрипты и сообщение клиента — обычно 5–20 секунд.
          </div>
        )}
        {error && <Note kind="error">{error}</Note>}

        {result && !busy && (
          <div className="assist-result">
            <div className="assist-summary">
              <span className="assist-lang">Клиент пишет: {langInfo(result.language).name}</span>
              {result.comment && <p className="assist-comment">{result.comment}</p>}
            </div>

            {matches.length > 0 && (
              <section className="assist-section">
                <h3 className="assist-section-title">
                  {matches.length === 1 ? "Подходящий скрипт" : "Подходящие скрипты"}
                </h3>
                {matches.map((m) => (
                  <MatchCard
                    key={m.item.id}
                    item={m.item}
                    section={m.section}
                    why={m.why}
                    lang={result.language}
                    studio={studio}
                    resolveVar={resolveVar}
                    onOpen={() => {
                      ref.current?.close();
                      onOpen(m.item, m.section);
                    }}
                  />
                ))}
              </section>
            )}

            {result.reply && (
              <section className="assist-section">
                <div className="assist-msg-head">
                  <h3 className="assist-section-title">
                    {matches.length ? "Ответ ИИ" : "Подходящего скрипта нет — ответ ИИ"}
                  </h3>
                  <CopyButton text={reply} />
                </div>
                <textarea
                  className="assist-reply"
                  lang={result.language}
                  rows={Math.min(14, Math.max(4, reply.split("\n").length + 1))}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                />
                <p className="muted assist-note">
                  Проверьте перед отправкой: места в [скобках] заполните сами.
                </p>
              </section>
            )}

            {!matches.length && !result.reply && (
              <Note kind="info">ИИ не нашёл подходящего скрипта и не предложил ответа.</Note>
            )}
          </div>
        )}
      </div>
    </dialog>
  );
}
