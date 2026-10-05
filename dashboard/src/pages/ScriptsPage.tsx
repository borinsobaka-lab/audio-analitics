/** Скрипты — то, что администратор пишет клиенту и говорит по телефону.
 *
 *  Замена Google-документа. В документе нужный ответ искали прокруткой
 *  через три языка, а копировали выделением мышью — вместе с пометками
 *  «RU:» и «После отправки…». Здесь:
 *  - поиск по всему сразу, с подсветкой; «/» ставит курсор в поиск;
 *  - язык и студия выбираются один раз на все скрипты;
 *  - каждое сообщение копируется одной кнопкой, ровно то, что уйдёт в чат.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, fmtWhen, plural, ScriptItem, ScriptItemDraft, ScriptLang, ScriptSection } from "../api";
import { Empty, Note, PageHead, Skeleton } from "../components/ui";
import { DEFAULT_SECTION_ICON } from "../components/navIcons";
import { Slider } from "../components/Slider";
import ScriptCard from "../scripts/ScriptCard";
import ScriptEditor, { emptyDraft } from "../scripts/ScriptEditor";
import SuggestDialog from "../scripts/SuggestDialog";
import CallRunner from "../scripts/CallRunner";
import CallEditor from "../scripts/CallEditor";
import SectionForm from "../scripts/SectionForm";
import { DotsMenu, SectionMenu } from "../scripts/SectionMenu";
import AssistDialog, { IconSparkle } from "../scripts/AssistDialog";
import {
  BUILTIN_VARIABLES,
  findByTitle,
  LANGS,
  makeResolver,
  scriptPath,
  searchScripts,
  searchTerms,
  studioLabels,
  totalScripts,
} from "../scripts/logic";
import { usePlaybook, useScriptPrefs } from "../scripts/store";
import { useSession, useStudio } from "../session";

const IconSearch = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.2-4.2" />
  </svg>
);


export default function ScriptsPage() {
  const me = useSession();
  const canEdit = me.can_edit_scripts;
  const { sectionId } = useParams();
  const [params] = useSearchParams();
  const focusId = params.get("item");
  const navigate = useNavigate();
  const location = useLocation();
  const { playbook, settings, error, reload, assistPending, setAssistPending } = usePlaybook();
  const { locations } = useStudio();
  const { lang, setLang, studio, setStudio } = useScriptPrefs();

  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [assisting, setAssisting] = useState(false);
  // Правка сценария звонка открытого раздела.
  const [editingFlow, setEditingFlow] = useState(false);
  const [suggesting, setSuggesting] = useState<{ id: string; title: string; section: string } | null>(null);
  /** Форма раздела: новый или правка названия и иконки конкретного. */
  const [sectionForm, setSectionForm] = useState<"new" | { edit: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Панель закреплена сверху; как только под ней поехал список, она
  // отделяется линией и тенью — иначе карточки просто «обрезаются» о неё.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setStuck(window.scrollY > 4));
    };
    check();
    window.addEventListener("scroll", check, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", check);
    };
  }, []);

  const sections = playbook?.sections ?? [];
  const terms = useMemo(() => searchTerms(query), [query]);
  const hits = useMemo(() => searchScripts(sections, terms), [sections, terms]);
  const section = sectionId ? sections.find((s) => s.id === sectionId) : undefined;
  const isCall = section?.kind === "call";
  // Текстовые скрипты живут только в текстовых разделах: звонок — один сценарий.
  const textSections = useMemo(() => sections.filter((s) => s.kind !== "call"), [sections]);

  // Студии — и те, под которые у скриптов есть свои варианты текста, и
  // работающие точки продаж: от выбранной зависит и вариант текста, и
  // подстановка {студия}.
  const studios = useMemo(() => {
    const names = studioLabels(sections);
    for (const l of locations) if (l.active && !names.includes(l.name)) names.push(l.name);
    return names;
  }, [sections, locations]);
  const editorStudios = studios;
  const activeStudio = studios.includes(studio) ? studio : studios[0] ?? "";

  const resolveVar = useMemo(
    () => makeResolver({ settings, me, lang, studio: activeStudio, locations }),
    [settings, me, lang, activeStudio, locations]
  );
  // ИИ-помощник отвечает на языке клиента — подстановка на этом языке.
  const resolverFor = useCallback(
    (l: ScriptLang) => makeResolver({ settings, me, lang: l, studio: activeStudio, locations }),
    [settings, me, activeStudio, locations]
  );
  const insertable = useMemo(
    () => [
      ...BUILTIN_VARIABLES,
      ...(settings?.variables ?? []).map((v) => ({ key: v.key, description: v.description })),
    ],
    [settings]
  );

  // «ИИ-помощник» из нижней панели на телефоне.
  useEffect(() => {
    if (!assistPending) return;
    setAssistPending(false);
    setAssisting(true);
  }, [assistPending, setAssistPending]);

  // Переход в другой раздел — это просмотр, а не поиск: запрос сбрасывается.
  useEffect(() => {
    setQuery("");
    setEditing(null);
    setSectionForm(null);
    setEditingFlow(false);
  }, [sectionId]);

  // «/» — к поиску из любого места страницы, кроме полей ввода.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable], dialog")) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ссылка на скрипт ведёт по id. Если скрипт с тех пор перенесли в другой
  // раздел (или ссылка без раздела), — открыть его настоящий раздел.
  useEffect(() => {
    if (!focusId || !playbook) return;
    const home = playbook.sections.find((s) => s.items.some((i) => i.id === focusId));
    if (home && sectionId && home.id !== sectionId)
      navigate(scriptPath(home.id, focusId), { replace: true });
  }, [focusId, playbook, sectionId, navigate]);

  // Ссылка на конкретный скрипт: докрутить и подсветить — один раз на
  // переход. Скрипты сначала показываются из сохранённого, а через миг
  // приходят свежие: второй прокрутки и второй подсветки быть не должно.
  // Если в сохранённом скрипта ещё нет — докрутим, когда придут свежие.
  const focused = useRef("");
  useEffect(() => {
    if (!focusId || !playbook) return;
    const mark = `${location.key}|${focusId}`;
    if (focused.current === mark) return;
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(`script-${focusId}`);
      if (!el) return;
      focused.current = mark;
      el.scrollIntoView({ block: "start" });
      setFlash(focusId);
    });
    return () => cancelAnimationFrame(frame);
    // sectionId — чтобы докрутить и после переадресации в настоящий раздел.
  }, [focusId, playbook, sectionId, location.key]);

  // Подсветка гаснет сама — отдельно от прокрутки, чтобы обновление данных
  // посреди подсветки не оставило её гореть навсегда.
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 2400);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const openScript = useCallback(
    (target: { item: ScriptItem; section: ScriptSection }) => {
      setQuery("");
      navigate(scriptPath(target.section.id, target.item.id));
    },
    [navigate]
  );

  const resolveId = useCallback(
    (id: string) => {
      for (const sec of sections)
        for (const item of sec.items)
          if (item.id === id) return { open: () => openScript({ item, section: sec }), title: item.title };
      return null;
    },
    [sections, openScript]
  );

  const resolveRef = useCallback(
    (title: string) => {
      const found = findByTitle(sections, title);
      return found ? () => openScript(found) : null;
    },
    [sections, openScript]
  );

  /** Действие и перечитывание дерева. false — не вышло, ошибка уже на экране. */
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setActionError(null);
    try {
      await action();
      await reload();
      return true;
    } catch (e) {
      setActionError((e as Error).message);
      return false;
    }
  }

  /** «+ Скрипт»: редактор нового скрипта — над списком, в открытом
   *  разделе (в «Все скрипты» — в первом; раздел меняется в самом редакторе). */
  function startNewScript() {
    setQuery("");
    setSectionForm(null);
    setEditing("new");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function moveSection(sec: ScriptSection, delta: -1 | 1) {
    const ids = sections.map((s) => s.id);
    const index = ids.indexOf(sec.id);
    ids.splice(index, 1);
    ids.splice(index + delta, 0, sec.id);
    return run(() => api.orderScriptSections(ids));
  }

  function sectionMenu(sec: ScriptSection) {
    if (!canEdit) return null;
    const index = sections.indexOf(sec);
    return (
      <SectionMenu
        section={sec}
        isFirst={index <= 0}
        isLast={index >= sections.length - 1}
        onEdit={() => {
          setEditing(null);
          setSectionForm({ edit: sec.id });
        }}
        onMove={(delta) => moveSection(sec, delta)}
        onDelete={() =>
          run(() => api.deleteScriptSection(sec.id)).then((ok) => {
            if (ok && sectionId === sec.id) navigate("/scripts");
          })
        }
      />
    );
  }

  function sectionEditForm(sec: ScriptSection) {
    if (!canEdit || !sectionForm || sectionForm === "new" || sectionForm.edit !== sec.id) return null;
    return (
      <SectionForm
        heading="Раздел"
        submitLabel="Сохранить"
        initialTitle={sec.title}
        initialIcon={sec.icon || DEFAULT_SECTION_ICON}
        onSubmit={({ title, icon }) => run(() => api.updateScriptSection(sec.id, { title, icon }))}
        onDone={() => setSectionForm(null)}
      />
    );
  }

  function moveItem(sec: ScriptSection, index: number, delta: -1 | 1) {
    const ids = sec.items.map((i) => i.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id);
    run(() => api.orderScripts(sec.id, ids));
  }

  async function saveItem(item: ScriptItem | null, draft: ScriptItemDraft, changeNote: string) {
    const body = {
      section_id: draft.section_id,
      title: draft.title,
      kind: draft.kind,
      keywords: draft.keywords,
      note: draft.note,
      follow_up: draft.follow_up,
      variants: draft.variants,
      change_note: changeNote,
    };
    if (item) await api.updateScript(item.id, body);
    else await api.createScript(body);
    await reload();
    setEditing(null);
    if (draft.section_id !== sectionId) navigate(scriptPath(draft.section_id));
  }

  if (error && !playbook) {
    return (
      <>
        <PageHead title="Скрипты" />
        <Note kind="error">Не удалось загрузить скрипты: {error}</Note>
      </>
    );
  }

  if (!playbook) {
    return (
      <>
        <PageHead title="Скрипты" />
        <Skeleton count={5} height={84} />
      </>
    );
  }

  function renderCard(item: ScriptItem, sec: ScriptSection, index: number, showSection: boolean) {
    if (editing === item.id) {
      return (
        <ScriptEditor
          key={item.id}
          initial={item}
          sections={textSections}
          studios={editorStudios}
          variables={insertable}
          isNew={false}
          onSave={(draft, note) => saveItem(item, draft, note)}
          onCancel={() => setEditing(null)}
          onDelete={async () => {
            await api.deleteScript(item.id);
            await reload();
            setEditing(null);
          }}
        />
      );
    }
    return (
      <ScriptCard
        key={item.id}
        item={item}
        section={sec}
        showSection={showSection}
        terms={terms}
        lang={lang}
        studio={activeStudio}
        onStudio={setStudio}
        resolveRef={resolveRef}
        resolveId={resolveId}
        resolveVar={resolveVar}
        flash={flash === item.id}
        canEdit={canEdit}
        onEdit={() => setEditing(item.id)}
        onSuggest={() => setSuggesting({ id: item.id, title: item.title, section: sec.title })}
        onMove={(delta) => moveItem(sec, index, delta)}
        isFirst={index === 0}
        isLast={index === sec.items.length - 1}
      />
    );
  }

  function renderSection(sec: ScriptSection) {
    return (
      <div className="script-list">
        {sec.items.map((item, i) => renderCard(item, sec, i, false))}
        {!sec.items.length && (
          <Empty title="В разделе пока нет скриптов">
            {canEdit ? "Добавьте первый кнопкой «+ Скрипт» вверху." : "Их добавит владелец."}
          </Empty>
        )}
      </div>
    );
  }

  const searching = terms.length > 0;
  const total = totalScripts(sections);
  const title = searching ? "Поиск" : section ? section.title : "Все скрипты";
  const hint = searching
    ? hits.length
      ? `${hits.length} ${plural(hits.length, "скрипт", "скрипта", "скриптов")} по запросу «${query.trim()}»`
      : undefined
    : section && isCall
      ? section.flow_updated_at
        ? `Сценарий звонка · обновлён ${fmtWhen(section.flow_updated_at)}${section.flow_updated_by ? ` · ${section.flow_updated_by}` : ""}${section.flow_change_note ? ` — ${section.flow_change_note}` : ""}`
        : "Сценарий звонка"
      : section
      ? `${section.items.length} ${plural(section.items.length, "скрипт", "скрипта", "скриптов")}`
      : `${total} ${plural(total, "скрипт", "скрипта", "скриптов")} в ${sections.length} ${plural(sections.length, "разделе", "разделах", "разделах")}`;

  return (
    <div className="scripts-page">
      <div className={`script-toolbar${stuck ? " stuck" : ""}`}>
        <label className="search">
          <IconSearch />
          <input
            ref={searchRef}
            type="text"
            inputMode="search"
            value={query}
            placeholder="Поиск: «дорого», «адрес», «шпагат»…"
            aria-label="Поиск по скриптам"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
          />
          {query ? (
            <button type="button" className="ghost small search-clear" onClick={() => {
              setQuery("");
              searchRef.current?.focus();
            }} aria-label="Очистить поиск">
              ✕
            </button>
          ) : (
            // Подсказка, что поиск открывается с клавиатуры: одна клавиша «/»
            // быстрее, чем дотянуться до поля мышью.
            <span className="search-hint" aria-hidden="true">
              быстрый поиск <kbd className="search-kbd">/</kbd>
            </span>
          )}
        </label>
        <div className="script-prefs">
          <Slider className="seg" active={lang} role="group" aria-label="Язык текста">
            {LANGS.map((l) => (
              <button
                key={l.key}
                type="button"
                className={`seg-btn${lang === l.key ? " on" : ""}`}
                aria-pressed={lang === l.key}
                title={l.name}
                onClick={() => setLang(l.key)}
              >
                {l.label}
              </button>
            ))}
          </Slider>
          {studios.length > 1 && (
            <Slider className="seg" active={activeStudio} role="group" aria-label="Студия">
              {studios.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`seg-btn${activeStudio === s ? " on" : ""}`}
                  aria-pressed={activeStudio === s}
                  onClick={() => setStudio(s)}
                >
                  {s}
                </button>
              ))}
            </Slider>
          )}
        </div>
        {/* ИИ-помощник — всем, кто отвечает клиентам. */}
        <button type="button" className="secondary assist-btn" onClick={() => setAssisting(true)}
          title="Вставьте сообщение клиента — ИИ подберёт скрипт или напишет ответ">
          <IconSparkle /> ИИ-помощник
        </button>
        {canEdit && !isCall && textSections.length > 0 && (
          <button type="button" className="secondary add-script-btn" onClick={startNewScript}
            title="Новый скрипт">
            <span aria-hidden="true">+</span> Скрипт
          </button>
        )}
      </div>
      {/* Предложить может любой, кто видит скрипты: прав на правку у
          администраторов у стойки нет, а неудачный текст замечают они. */}
      {suggesting && <SuggestDialog item={suggesting} onClose={() => setSuggesting(null)} />}
      {assisting && (
        <AssistDialog
          sections={sections}
          lang={lang}
          studio={activeStudio}
          resolverFor={resolverFor}
          onOpen={(item, sec) => {
            setAssisting(false);
            openScript({ item, section: sec });
          }}
          onClose={() => setAssisting(false)}
        />
      )}

      {/* На телефоне разделы — в нижней панели (App → MobileScriptsBar). */}

      <PageHead
        title={
          !searching && section ? (
            <span className="title-with-menu">
              {title}
              {sectionMenu(section)}
            </span>
          ) : canEdit && !searching && !sectionId ? (
            <span className="title-with-menu">
              {title}
              <DotsMenu label="Все скрипты: действия" title="Новый раздел">
                {(close) => (
                  <button type="button" role="menuitem" onClick={() => {
                    close();
                    setEditing(null);
                    setSectionForm("new");
                  }}>
                    + Новый раздел
                  </button>
                )}
              </DotsMenu>
            </span>
          ) : (
            title
          )
        }
        hint={hint}
      />

      {canEdit && !searching && sectionForm === "new" && !sectionId && (
        <SectionForm
          heading="Новый раздел"
          submitLabel="Создать"
          initialTitle=""
          initialIcon={DEFAULT_SECTION_ICON}
          withKind
          onSubmit={(body) => run(() => api.createScriptSection(body))}
          onDone={() => setSectionForm(null)}
        />
      )}
      {!searching && section && sectionEditForm(section)}

      {actionError && <Note kind="error">{actionError}</Note>}

      {canEdit && editing === "new" && textSections.length > 0 && (
        <div className="new-script">
          <ScriptEditor
            initial={emptyDraft(section && !isCall ? section.id : textSections[0].id)}
            sections={textSections}
            studios={editorStudios}
            variables={insertable}
            isNew
            onSave={(draft, note) => saveItem(null, draft, note)}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      {searching ? (
        hits.length ? (
          <div className="script-list">
            {hits.map(({ item, section: sec }) =>
              renderCard(item, sec, sec.items.indexOf(item), true)
            )}
          </div>
        ) : (
          <Empty title="Ничего не нашлось">
            Ищем по названиям, текстам на всех языках и пояснениям. Попробуйте
            другое слово или начало слова: «шпагат», «оплат».
          </Empty>
        )
      ) : section && isCall && section.flow ? (
        canEdit && editingFlow ? (
          <CallEditor
            section={section}
            sections={sections}
            variables={insertable}
            onSaved={async () => {
              await reload();
              setEditingFlow(false);
            }}
            onCancel={() => setEditingFlow(false)}
          />
        ) : (
          <CallRunner
            key={section.id}
            section={section}
            lang={lang}
            resolveVar={resolveVar}
            resolveRef={resolveRef}
            resolveId={resolveId}
            canEdit={canEdit}
            onEdit={() => setEditingFlow(true)}
          />
        )
      ) : section ? (
        renderSection(section)
      ) : sectionId ? (
        <Empty title="Раздел не найден">Его могли удалить. Откройте «Все скрипты».</Empty>
      ) : sections.length ? (
        sections.map((sec) => (
          <div className="section" key={sec.id}>
            <div className="section-head">
              <h3>
                <NavLink to={`/scripts/${sec.id}`} className="section-link">
                  {sec.title}
                </NavLink>
              </h3>
              <span className="count">{sec.items.length}</span>
              {sectionMenu(sec)}
            </div>
            {sectionEditForm(sec)}
            {sec.kind === "call" && sec.flow ? (
              <NavLink to={`/scripts/${sec.id}`} className="call-teaser">
                <span className="call-teaser-icon" aria-hidden="true">☎</span>
                <span className="call-teaser-text">
                  <strong>Сценарий звонка</strong>
                  <span className="muted">
                    {sec.flow.nodes.filter((n) => n.group === "main").length} этапов ·{" "}
                    {sec.flow.nodes.filter((n) => n.group === "objection").length} возражений — читайте
                    с экрана и кликайте ответы клиента
                  </span>
                </span>
                <span className="call-teaser-go">Начать звонок →</span>
              </NavLink>
            ) : (
              renderSection(sec)
            )}
          </div>
        ))
      ) : (
        <Empty title="Скриптов пока нет">
          {canEdit ? "Создайте первый раздел: «⋯» рядом с заголовком → «Новый раздел»." : "Их добавит владелец."}
        </Empty>
      )}
    </div>
  );
}
