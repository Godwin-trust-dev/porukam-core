import { trackInstallEvent } from '../analytics/installEvents';

/** Пакет приложения в Google Play. Зафиксирован консолью и менять его нельзя
 *  (docs/ops/play-console.md §8): смена `applicationId` — это другое
 *  приложение, а не обновление этого. */
export const PLAY_PACKAGE_NAME = 'porukam.app';

/**
 * Параметр `referrer` ссылки на Play. Play Console раскладывает установки по
 * каналам ровно по нему — и только по нему: своего «откуда пришёл» у магазина
 * нет, а без параметра установка с нашего сайта неотличима от установки из
 * поиска по магазину.
 *
 * Значение — UTM-строка, которую Play обязан получить УЖЕ ЗАКОДИРОВАННОЙ
 * (`utm_source%3D…%26utm_medium%3D…`): двоеточия и амперсанды внутри referrer
 * иначе съест разбор самого URL магазина. Поэтому здесь константа-строка, а
 * не сборка через URLSearchParams — кодирование тут одноразовое и внешнее.
 */
export const PLAY_REFERRER = 'utm_source%3Dporukam.app%26utm_medium%3Dsite%26utm_campaign%3Dinstall';

/**
 * Ссылка на приложение в Google Play с атрибуцией «пришёл с сайта».
 *
 * Кнопки с этой ссылкой в интерфейсе пока НЕТ — приложение проходит Internal
 * testing (docs/ops/play-console.md). Константа и счётчик заведены заранее и
 * намеренно: место вывода решает владелец, а метрика обязана существовать
 * раньше кнопки, иначе первые дни канала останутся неизмеренными.
 */
export const PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${PLAY_PACKAGE_NAME}&referrer=${PLAY_REFERRER}`;

/**
 * Переход в магазин. Считаем НАМЕРЕНИЕ: установку по ту сторону магазина
 * видит только Play Console, обратного вызова на сайт у Play нет. Как свести
 * одно с другим — docs/ops/play-console.md, «Атрибуция установок с сайта».
 */
export function trackPlayClick(): void {
  trackInstallEvent('play_click');
}
