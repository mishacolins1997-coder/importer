# Data Importer для SillyTavern

Массовый импорт скачанных данных одним окном.

## Что умеет
| Тип | Форматы | Как импортируется |
|---|---|---|
| Персонажи | png, json (V1/V2/V3), yaml, charx, byaf | `/api/characters/import` |
| Лорбуки / миры | json (ST, NovelAI, Agnai, Risu, character_book) | напрямую или через штатный импорт World Info |
| Чаты | jsonl (ST), json (Ooba, Agnai, CAI) | `/api/chats/import`, персонаж подбирается по имени из файла |
| Пресеты | Chat/Text Completion, Kobold, NovelAI, Instruct, Context, System Prompt, Reasoning | `/api/presets/save` |
| Темы, Quick Reply | json | `/api/themes/save`, `/api/quick-replies/save` |
| Фоны, аватары персон | png/jpg/webp/gif | `/api/backgrounds/upload`, `/api/avatars/upload` |
| Расширения | Git-ссылки | `/api/extensions/install` |

Тип определяется автоматически по содержимому, его можно поменять в выпадающем списке.
Можно перетащить целую папку.

## Установка
**Способ 1 (вручную):** скопируйте папку `SillyTavern-DataImporter` в
`data/<ваш-пользователь>/extensions/` (обычно `data/default-user/extensions/`) и перезапустите/обновите страницу.

**Способ 2 (Git):** выложите папку в репозиторий и установите через
Extensions → Install extension.

## Где найти
- Extensions (три кубика) → Data Importer → «Открыть импортёр»
- Меню волшебной палочки → «Импортёр данных»

## Ограничения
- Одноимённые лорбуки/пресеты/темы перезаписываются.
- Темы, Quick Reply, фоны и новые расширения видны после перезагрузки страницы.
- ZIP-архивы не распаковываются.
