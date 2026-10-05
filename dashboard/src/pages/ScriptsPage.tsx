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
import { NavLink, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, plural, ScriptItem, ScriptItemDraft, ScriptSection } from "../api";
import { Empty, Note, PageHead, Skeleton } from "../components/ui";
import { DEFAULT_SECTION_ICON, SECTION_ICONS } from "../components/navIcons";
import { Slider } from "../components/Slider";
import ScriptCard from "../scripts/ScriptCard";
import ScriptEditor, { emptyDraft } from "../scripts/ScriptEditor";
import SuggestDialog from "../scripts/SuggestDialog";
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
  const { playbook, settings, error, reload } = usePlaybook();
  const { locations } = useStudio();
  const { lang, setLang, studio, setStudio } = useScriptPrefs();

  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState<{ id: string; title: string; section: string } | null>(null);
  /** Форма раздела: новый или правка названия и иконки конкретного. */
  const [sectionForm, setSectionForm] = useState<"new" | { edit: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const sections = playbook?.sections ?? [];
  const terms = useMemo(() => searchTerms(query), [query]);
  const hits = useMemo(() => searchScripts(sections, terms), [sections, terms]);
  const section = sectionId ? sections.find((s) => s.id === sectionId) : undefined;

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
  const insertable = useMemo(
    () => [
      ...BUILTIN_VARIABLES,
      ...(settings?.variables ?? []).map((v) => ({ key: v.key, description: v.description })),
    ],
    [settings]
  );

  // Переход в другой раздел — это просмотр, а не поиск: запрос сбрасывается.
  useEffect(() => {
    setQuery("");
    setEditing(null);
    setSectionForm(null);
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

  // Ссылка на конкретный скрипт: докрутить и коротко подсветить.
  useEffect(() => {
    if (!focusId || !playbook) return;
    setFlash(focusId);
    const frame = requestAnimationFrame(() =>
      document.getElementById(`script-${focusId}`)?.scrollIntoView({ block: "start" })
    );
    const timer = window.setTimeout(() => setFlash(null), 1600);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [focusId, playbook]);

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
        onSubmit={(body) => run(() => api.updateScriptSection(sec.id, body))}
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
          sections={sections}
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
    : section
      ? `${section.items.length} ${plural(section.items.length, "скрипт", "скрипта", "скриптов")}`
      : `${total} ${plural(total, "скрипт", "скрипта", "скриптов")} в ${sections.length} ${plural(sections.length, "разделе", "разделах", "разделах")}`;

  return (
    <div className="scripts-page">
      <div className="script-toolbar">
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
        {canEdit && (
          <button type="button" className="secondary add-script-btn" onClick={startNewScript}
            title="Новый скрипт">
            <span aria-hidden="true">+</span> Скрипт
          </button>
        )}
      </div>
      {/* Предложить может любой, кто видит скрипты: прав на правку у
          администраторов у стойки нет, а неудачный текст замечают они. */}
      {suggesting && <SuggestDialog item={suggesting} onClose={() => setSuggesting(null)} />}

      {/* На телефоне боковое меню — узкая полоса, и разделы в ней не
          поместятся: там они живут здесь, лентой над списком. */}
      <nav className="script-chips" aria-label="Разделы скриптов">
        <NavLink to="/scripts" end className="chip">
          Все
        </NavLink>
        {sections.map((s) => (
          <NavLink key={s.id} to={`/scripts/${s.id}`} className="chip">
            {s.title}
          </NavLink>
        ))}
        {canEdit && (
          <NavLink to="/scripts/settings" className="chip">
            Настройки
          </NavLink>
        )}
      </nav>

      <PageHead
        title={
          !searching && section ? (
            <span className="title-with-menu">
              {title}
              {sectionMenu(section)}
            </span>
          ) : (
            title
          )
        }
        hint={hint}
      >
        {canEdit && !searching && !section && !sectionId && !sectionForm && (
          <button type="button" className="secondary" onClick={() => setSectionForm("new")}>
            Новый раздел
          </button>
        )}
      </PageHead>

      {canEdit && !searching && sectionForm === "new" && !sectionId && (
        <SectionForm
          heading="Новый раздел"
          submitLabel="Создать"
          initialTitle=""
          initialIcon={DEFAULT_SECTION_ICON}
          onSubmit={(body) => run(() => api.createScriptSection(body))}
          onDone={() => setSectionForm(null)}
        />
      )}
      {!searching && section && sectionEditForm(section)}

      {actionError && <Note kind="error">{actionError}</Note>}

      {canEdit && editing === "new" && sections.length > 0 && (
        <div className="new-script">
          <ScriptEditor
            initial={emptyDraft(section?.id ?? sections[0].id)}
            sections={sections}
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
            {renderSection(sec)}
          </div>
        ))
      ) : (
        <Empty title="Скриптов пока нет">
          {canEdit ? "Создайте первый раздел кнопкой «Новый раздел»." : "Их добавит владелец."}
        </Empty>
      )}
    </div>
  );
}

/** Название и иконка раздела. Иконка — из набора Solar, тем же стилем, что
 *  остальное меню: свободная загрузка картинок развалила бы его в разнобой. */
function SectionForm({
  heading,
  submitLabel,
  initialTitle,
  initialIcon,
  onSubmit,
  onDone,
}: {
  heading: string;
  submitLabel: string;
  initialTitle: string;
  initialIcon: string;
  onSubmit: (body: { title: string; icon: string }) => Promise<boolean>;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [icon, setIcon] = useState(initialIcon);
  const [saving, setSaving] = useState(false);

  return (
    <form
      className="sheet sheet-pad section-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim() || saving) return;
        setSaving(true);
        onSubmit({ title: title.trim(), icon }).then((ok) => {
          setSaving(false);
          if (ok) onDone();
        });
      }}
    >
      <h3>{heading}</h3>
      <label className="field">
        <span className="label">Название</span>
        <input
          type="text"
          value={title}
          autoFocus
          placeholder="Например: «Работа с отзывами»"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <div className="field">
        <span className="label" id="section-icon-label">Иконка в меню</span>
        <div className="icon-picker" role="radiogroup" aria-labelledby="section-icon-label">
          {SECTION_ICONS.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={icon === key}
              aria-label={label}
              title={label}
              className={`icon-choice${icon === key ? " on" : ""}`}
              onClick={() => setIcon(key)}
            >
              <Icon size={22} />
            </button>
          ))}
        </div>
      </div>
      <div className="actions">
        <button type="submit" disabled={!title.trim() || saving}>
          {saving ? "Сохраняем…" : submitLabel}
        </button>
        <button type="button" className="ghost" onClick={onDone} disabled={saving}>
          Отмена
        </button>
      </div>
    </form>
  );
}

const IconDots = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5.5" cy="12" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="18.5" cy="12" r="1.7" />
  </svg>
);

/** «⋯» справа от названия раздела: название и иконка, порядок в меню,
 *  удаление пустого раздела. Нужно редко — поэтому в меню, а не кнопками
 *  в шапке страницы, где они отвлекали от скриптов. */
function SectionMenu({
  section,
  isFirst,
  isLast,
  onEdit,
  onMove,
  onDelete,
}: {
  section: ScriptSection;
  isFirst: boolean;
  isLast: boolean;
  onEdit: () => void;
  onMove: (delta: -1 | 1) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) {
      setConfirmDelete(false);
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="section-menu" ref={ref}>
      <button
        type="button"
        className={`section-menu-btn${open ? " on" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Раздел «${section.title}»: действия`}
        title="Название, иконка, порядок"
        onClick={() => setOpen((v) => !v)}
      >
        <IconDots />
      </button>
      {open && (
        <span className="menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onEdit(); }}>
            Название и иконка
          </button>
          {/* Порядок — меню не закрывается: раздел часто двигают на
              несколько позиций подряд. */}
          <button type="button" role="menuitem" disabled={isFirst} onClick={() => onMove(-1)}>
            ↑ Выше в меню
          </button>
          <button type="button" role="menuitem" disabled={isLast} onClick={() => onMove(1)}>
            ↓ Ниже в меню
          </button>
          {/* Раздел со скриптами не удаляется вовсе — сервер откажет, и
              прятать пункт честнее, чем показывать отказ. */}
          {section.items.length === 0 &&
            (confirmDelete ? (
              <button type="button" role="menuitem" className="danger"
                onClick={() => { setOpen(false); onDelete(); }}>
                Точно удалить раздел
              </button>
            ) : (
              <button type="button" role="menuitem" className="danger"
                onClick={() => setConfirmDelete(true)}>
                Удалить раздел…
              </button>
            ))}
        </span>
      )}
    </span>
  );
}
