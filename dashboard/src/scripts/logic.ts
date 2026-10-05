/** Скрипты без React: поиск, выбор текста, копирование.
 *
 *  Отдельно от компонентов, потому что это правила, а не вёрстка: какой
 *  вариант показать, что делать с отсутствующим переводом, что считается
 *  совпадением. Их легко сломать правкой разметки, если они в ней живут.
 */
import type {
  LangText,
  Location,
  Me,
  PlaybookSettings,
  ScriptItem,
  ScriptKind,
  ScriptLang,
  ScriptMessage,
  ScriptSection,
  ScriptVariant,
} from "../api";

export const LANGS: { key: ScriptLang; label: string; name: string; inName: string }[] = [
  { key: "ru", label: "RU", name: "русский", inName: "русском" },
  { key: "en", label: "EN", name: "английский", inName: "английском" },
  // В документе и в речи администраторов — «GE», не ISO-шное «KA».
  { key: "ka", label: "GE", name: "грузинский", inName: "грузинском" },
];

export const KIND_LABELS: Record<ScriptKind, string> = {
  chat: "Чат",
  call: "Звонок",
  task: "Задача",
  info: "Справка",
};

export function langInfo(lang: ScriptLang) {
  return LANGS.find((l) => l.key === lang) ?? LANGS[0];
}

/** Строка для сравнения: регистр и «ё» не должны мешать найти «ещё».
 *
 *  Посимвольно и с сохранением длины: по индексам совпадений в нормальной
 *  строке потом подсвечиваются куски исходной. */
export function normalize(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const lower = c.toLowerCase();
    if (lower.length !== 1) out += c;
    else out += lower === "ё" ? "е" : lower;
  }
  return out;
}

export function searchTerms(query: string): string[] {
  return normalize(query.trim()).split(/\s+/).filter(Boolean);
}

export interface SearchHit {
  item: ScriptItem;
  section: ScriptSection;
}

/** Совпадение — все слова запроса найдены где угодно в скрипте: в названии,
 *  словах для поиска, пояснениях и текстах на любом языке. Сначала идут
 *  скрипты, где слова стоят в названии: «дорого» должно поднимать возражение
 *  «Дорого», а не каждое сообщение, где встречается «недорого». */
export function searchScripts(sections: ScriptSection[], terms: string[]): SearchHit[] {
  if (!terms.length) return [];
  const scored: { hit: SearchHit; score: number; order: number }[] = [];
  let order = 0;
  for (const section of sections) {
    for (const item of section.items) {
      order++;
      const title = normalize(item.title);
      const keywords = normalize(item.keywords);
      const body = normalize(
        [
          section.title,
          stripMarkup(item.note),
          stripMarkup(item.follow_up),
          ...item.variants.flatMap((v) => [
            v.label,
            ...v.messages.flatMap((m) => [m.label, m.ru, m.en, m.ka]),
          ]),
        ].join("\n")
      );
      let score = 0;
      let all = true;
      for (const term of terms) {
        if (title.includes(term)) score += title.startsWith(term) ? 14 : 10;
        else if (keywords.includes(term)) score += 5;
        else if (body.includes(term)) score += 1;
        else {
          all = false;
          break;
        }
      }
      if (all) scored.push({ hit: { item, section }, score, order });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((s) => s.hit);
}

/** Студии, для которых у скриптов есть свои варианты текста. */
export function studioLabels(sections: ScriptSection[]): string[] {
  const seen: string[] = [];
  for (const section of sections)
    for (const item of section.items)
      for (const variant of item.variants)
        if (variant.label && !seen.includes(variant.label)) seen.push(variant.label);
  return seen;
}

/** Вариант под выбранную студию; если у скрипта такого нет — первый. */
export function pickVariant(item: ScriptItem, studio: string): ScriptVariant {
  return item.variants.find((v) => v.label && v.label === studio) ?? item.variants[0];
}

export interface ShownText {
  text: string;
  lang: ScriptLang;
  /** Перевода на выбранный язык нет, показан другой. */
  fallback: boolean;
}

/** Текст сообщения на выбранном языке. Перевода нет — показываем другой язык
 *  и говорим об этом прямо: молча подставленный русский в английском чате —
 *  ошибка, которую администратор заметит уже после отправки. */
export function messageText(message: ScriptMessage, lang: ScriptLang): ShownText {
  if (message[lang].trim()) return { text: message[lang], lang, fallback: false };
  const other = LANGS.find((l) => message[l.key].trim());
  return { text: other ? message[other.key] : "", lang: other?.key ?? lang, fallback: true };
}

/** Есть ли у скрипта текст на этом языке хоть в одном сообщении варианта. */
export function variantHasLang(variant: ScriptVariant, lang: ScriptLang): boolean {
  return variant.messages.some((m) => m[lang].trim());
}

/** Копирование в буфер. Clipboard API есть только на https и в фокусе;
 *  запасной путь через выделение textarea — для всего остального. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* ниже — запасной путь */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export function totalScripts(sections: ScriptSection[]): number {
  return sections.reduce((n, s) => n + s.items.length, 0);
}

/** Поиск скрипта по названию — для ссылок «…» в пояснениях. */
export function findByTitle(
  sections: ScriptSection[],
  title: string
): { item: ScriptItem; section: ScriptSection } | null {
  const wanted = normalize(title.trim());
  for (const section of sections)
    for (const item of section.items)
      if (normalize(item.title) === wanted) return { item, section };
  return null;
}

export function scriptPath(sectionId: string, itemId?: string): string {
  return itemId ? `/scripts/${sectionId}?item=${itemId}` : `/scripts/${sectionId}`;
}

/** Полная ссылка на скрипт — для CRM, базы знаний, переписки. Ведёт по id:
 *  если скрипт потом перенесут в другой раздел, страница сама найдёт его. */
export function scriptUrl(sectionId: string, itemId: string): string {
  return `${window.location.origin}${scriptPath(sectionId, itemId)}`;
}


/* --- Переменные: {админ}, {студия}, свои -------------------------------- */

/** {ключ}: буквы, цифры, подчёркивание. Квадратные скобки [день] — другое:
 *  это места, которые администратор заполняет руками. */
export const VARIABLE_RE = /\{([0-9A-Za-zА-Яа-яЁё_]{1,40})\}/g;

export const BUILTIN_VARIABLES: { key: string; description: string }[] = [
  { key: "админ", description: "имя того, кто вошёл, — из настроек скриптов" },
  { key: "студия", description: "выбранная студия — название на языке текста" },
];

export interface VarValue {
  /** null — переменная известна, но на этом языке значения нет. */
  value: string | null;
  /** Почему нет значения — для подсказки на подсвеченной переменной. */
  why?: string;
}

/** Подстановщик для текущего языка, студии и вошедшего. null в value —
 *  подставлять нечего (переменной нет в настройках или нет значения на этом
 *  языке): она подсвечивается оранжевым. undefined — настройки ещё не
 *  загружены, и текст в фигурных скобках пока остаётся текстом. */
export type VarResolver = (key: string) => VarValue | undefined;

function pick(texts: LangText | undefined, lang: ScriptLang): string | null {
  const value = texts?.[lang]?.trim();
  return value ? value : null;
}

export function makeResolver({
  settings,
  me,
  lang,
  studio,
  locations,
}: {
  settings: PlaybookSettings | null;
  me: Me;
  lang: ScriptLang;
  /** Выбранная студия — название варианта (совпадает с названием точки). */
  studio: string;
  locations: Location[];
}): VarResolver {
  const inLang = langInfo(lang).inName;
  return (rawKey) => {
    const key = rawKey.toLowerCase();
    if (key === "админ") {
      const mine = settings?.admins.find((a) => a.employee_id === me.employee_id);
      if (!mine)
        return {
          value: null,
          why: me.employee_id
            ? "Имя не задано — откройте «Настройки» скриптов"
            : "Вы вошли владельческим ключом — у ключа нет имени",
        };
      const value = pick(mine, lang);
      return value ? { value } : { value: null, why: `Нет имени на ${inLang} — задайте в настройках` };
    }
    if (key === "студия") {
      const studios = settings?.studios ?? [];
      const location = locations.find((l) => l.name === studio);
      const names =
        studios.find((s) => s.location_id === location?.id) ??
        studios.find((s) => s.location_name === studio || s.ru === studio) ??
        (studios.filter((s) => s.active).length === 1
          ? studios.find((s) => s.active)
          : undefined);
      if (!names) return { value: null, why: "Выберите студию вверху страницы" };
      const value = pick(names, lang);
      return value
        ? { value }
        : { value: null, why: `Нет названия студии на ${inLang} — задайте в настройках` };
    }
    const custom = settings?.variables.find((v) => v.key.toLowerCase() === key);
    if (!custom) {
      // Пока настройки не пришли, неизвестное не красим: это ещё не ошибка.
      if (!settings) return undefined;
      return {
        value: null,
        why: `Переменной {${rawKey}} нет в настройках — добавьте её в «Скрипты» → «Настройки»`,
      };
    }
    if (custom.type === "date") return { value: dateAfter(custom.offset_days ?? 0) };
    const value = pick(custom, lang);
    return value ? { value } : { value: null, why: `Нет значения на ${inLang} — задайте в настройках` };
  };
}

/** Дата через N дней от сегодня — только день и месяц, «12.06»: так пишут в
 *  чате о свободных местах, и так одинаково на всех трёх языках. Считается
 *  по часам компьютера администратора — то есть по тбилисскому времени. */
export function dateAfter(days: number, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

/** Подпись к дате в настройках: «ср, 07.10» — чтобы сразу видеть, не
 *  выпадает ли слот на выходной. */
export function dateAfterLabel(days: number, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  return `${WEEKDAYS[d.getDay()]}, ${dateAfter(days, from)}`;
}

/** Текст с подставленными переменными — то, что уйдёт в чат по кнопке
 *  «Копировать». Неизвестные и пустые остаются как были, в скобках: их
 *  видно и в чате, и на экране, где они подсвечены. */
export function resolveText(text: string, resolve: VarResolver): string {
  return text.replace(VARIABLE_RE, (whole, key: string) => resolve(key)?.value ?? whole);
}

/** Текст подсказки без разметки (**жирный**, __подчёркнутый__, ссылки на
 *  скрипты, [[копируемое]]) — для поиска и копирования: «**дорого**» должно находиться по «дорого». */
export function stripMarkup(text: string): string {
  return text
    .replace(/\[\[([^\]\n]+?)\]\]/g, "$1")
    .replace(/\[([^\]\n]+)\]\(script:[0-9a-fA-F-]{36}\)/g, "$1")
    .replace(/\*\*([^*\n]+?)\*\*/g, "$1")
    .replace(/__([^_\n]+?)__/g, "$1");
}
