/** Иконки бокового меню — набор Solar, стиль BoldDuotone.
 *
 *  Каждая иконка импортируется отдельным модулем: в сборку попадают только
 *  эти, а не три тысячи иконок пакета. Второй слой дуотона рисуется тем же
 *  цветом на половинной непрозрачности (переменная --solar-secondary-opacity),
 *  поэтому иконка перекрашивается вместе с текстом пункта — серая, белая или
 *  розовая — одним `color`.
 */
import type { ComponentType } from "react";
import { AlarmIcon } from "@solar-icons/react/bold-duotone/alarm";
import { BellIcon } from "@solar-icons/react/bold-duotone/bell";
import { CalendarIcon } from "@solar-icons/react/bold-duotone/calendar";
import { CalendarAddIcon } from "@solar-icons/react/bold-duotone/calendar-add";
import { Chart2Icon } from "@solar-icons/react/bold-duotone/chart-2";
import { ChatRoundDotsIcon } from "@solar-icons/react/bold-duotone/chat-round-dots";
import { ChatRoundLineIcon } from "@solar-icons/react/bold-duotone/chat-round-line";
import { ClipboardListIcon } from "@solar-icons/react/bold-duotone/clipboard-list";
import { CupStarIcon } from "@solar-icons/react/bold-duotone/cup-star";
import { DocumentTextIcon } from "@solar-icons/react/bold-duotone/document-text";
import { DocumentsIcon } from "@solar-icons/react/bold-duotone/documents";
import { DumbbellSmallIcon } from "@solar-icons/react/bold-duotone/dumbbell-small";
import { FireIcon } from "@solar-icons/react/bold-duotone/fire";
import { GiftIcon } from "@solar-icons/react/bold-duotone/gift";
import { HandHeartIcon } from "@solar-icons/react/bold-duotone/hand-heart";
import { HashtagCircleIcon } from "@solar-icons/react/bold-duotone/hashtag-circle";
import { LetterIcon } from "@solar-icons/react/bold-duotone/letter";
import { MapPointIcon } from "@solar-icons/react/bold-duotone/map-point";
import { PhoneCallingRoundedIcon } from "@solar-icons/react/bold-duotone/phone-calling-rounded";
import { QuestionCircleIcon } from "@solar-icons/react/bold-duotone/question-circle";
import { Shop2Icon } from "@solar-icons/react/bold-duotone/shop-2";
import { SettingsIcon } from "@solar-icons/react/bold-duotone/settings";
import { ShieldCheckIcon } from "@solar-icons/react/bold-duotone/shield-check";
import { SmartphoneUpdateIcon } from "@solar-icons/react/bold-duotone/smartphone-update";
import { StarShineIcon } from "@solar-icons/react/bold-duotone/star-shine";
import { TagPriceIcon } from "@solar-icons/react/bold-duotone/tag-price";
import { UsersGroupRoundedIcon } from "@solar-icons/react/bold-duotone/users-group-rounded";
import { WalletMoneyIcon } from "@solar-icons/react/bold-duotone/wallet-money";
import { Widget5Icon } from "@solar-icons/react/bold-duotone/widget-5";

type IconComponent = ComponentType<{ size?: number | string }>;

/** Разделы аналитики — набор постоянный, иконки закреплены за ними. */
export const NavIcons = {
  dashboard: Widget5Icon,
  days: CalendarIcon,
  calls: PhoneCallingRoundedIcon,
  metrics: Chart2Icon,
  people: UsersGroupRoundedIcon,
  studio: Shop2Icon,
  app: SmartphoneUpdateIcon,
  allScripts: DocumentsIcon,
  settings: SettingsIcon,
} satisfies Record<string, IconComponent>;

/** Иконки, из которых владелец выбирает иконку раздела скриптов. Ключи
 *  хранятся в базе, поэтому их нельзя переименовывать — только добавлять. */
export const SECTION_ICONS: { key: string; label: string; Icon: IconComponent }[] = [
  { key: "calendar-add", label: "Запись", Icon: CalendarAddIcon },
  { key: "chat-round-dots", label: "Переписка", Icon: ChatRoundDotsIcon },
  { key: "chat-round-line", label: "Сообщение", Icon: ChatRoundLineIcon },
  { key: "alarm", label: "Напоминание", Icon: AlarmIcon },
  { key: "bell", label: "Уведомление", Icon: BellIcon },
  { key: "hand-heart", label: "Забота", Icon: HandHeartIcon },
  { key: "question-circle", label: "Вопросы", Icon: QuestionCircleIcon },
  { key: "shield-check", label: "Возражения", Icon: ShieldCheckIcon },
  { key: "hashtag-circle", label: "Соцсети", Icon: HashtagCircleIcon },
  { key: "phone-calling-rounded", label: "Звонок", Icon: PhoneCallingRoundedIcon },
  { key: "wallet-money", label: "Оплата", Icon: WalletMoneyIcon },
  { key: "tag-price", label: "Цены", Icon: TagPriceIcon },
  { key: "gift", label: "Подарок", Icon: GiftIcon },
  { key: "fire", label: "Акция", Icon: FireIcon },
  { key: "star-shine", label: "Отзывы", Icon: StarShineIcon },
  { key: "cup-star", label: "Достижения", Icon: CupStarIcon },
  { key: "dumbbell-small", label: "Тренировки", Icon: DumbbellSmallIcon },
  { key: "map-point", label: "Адрес", Icon: MapPointIcon },
  { key: "letter", label: "Письмо", Icon: LetterIcon },
  { key: "clipboard-list", label: "Задачи", Icon: ClipboardListIcon },
  { key: "document-text", label: "Документ", Icon: DocumentTextIcon },
];

export const DEFAULT_SECTION_ICON = "document-text";

/** Иконка раздела по ключу. Неизвестный ключ (иконку убрали из набора) —
 *  иконка по умолчанию, а не пустое место в меню. */
export function sectionIcon(key: string | undefined): IconComponent {
  return (
    SECTION_ICONS.find((i) => i.key === key)?.Icon ??
    SECTION_ICONS.find((i) => i.key === DEFAULT_SECTION_ICON)!.Icon
  );
}

/** Иконка пункта меню в обёртке, которая несёт свечение. */
export function NavIcon({ icon: Icon }: { icon: IconComponent }) {
  return (
    <span className="nav-icon" aria-hidden="true">
      <Icon size={20} />
    </span>
  );
}
