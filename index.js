/**
 * Data Importer for SillyTavern
 * Массовый импорт: персонажи, лорбуки/миры, чаты, пресеты, темы, Quick Reply,
 * фоны, аватары персон, а также установка расширений по Git-ссылкам.
 * Тип файла определяется автоматически, его можно поменять вручную.
 */

const MODULE = 'st_data_importer';
const ctx = () => SillyTavern.getContext();

const defaultSettings = { autoMatch: true, preserveName: false, globalInstall: false, skipDupChats: true, autoLore: true, embeddedBook: true };

const TYPES = {
    character: 'Персонаж',
    world: 'Лорбук / Мир (World Info)',
    chat: 'Чат (jsonl / json)',
    preset_openai: 'Пресет: Chat Completion',
    preset_textgen: 'Пресет: Text Completion',
    preset_kobold: 'Пресет: KoboldAI',
    preset_novel: 'Пресет: NovelAI',
    preset_instruct: 'Шаблон Instruct',
    preset_context: 'Шаблон Context (Story String)',
    preset_sysprompt: 'Системный промпт',
    preset_reasoning: 'Шаблон Reasoning',
    quickreply: 'Набор Quick Reply',
    theme: 'Тема интерфейса',
    background: 'Фон',
    persona_backup: 'Бэкап персон (JSON из Persona Management)',
    avatar: 'Аватар персоны (user)',
    skip: '— пропустить —',
};

const PRESET_API = {
    preset_openai: 'openai',
    preset_textgen: 'textgenerationwebui',
    preset_kobold: 'kobold',
    preset_novel: 'novel',
    preset_instruct: 'instruct',
    preset_context: 'context',
    preset_sysprompt: 'sysprompt',
    preset_reasoning: 'reasoning',
};

// Порядок импорта: сначала персонажи и миры, чаты — в самом конце
const ORDER = [
    'world', 'character',
    'preset_openai', 'preset_textgen', 'preset_kobold', 'preset_novel',
    'preset_instruct', 'preset_context', 'preset_sysprompt', 'preset_reasoning',
    'theme', 'quickreply', 'background', 'persona_backup', 'avatar', 'chat',
];

const state = { items: [], nextId: 1, busy: false, imported: new Set(), root: null, chatSeen: new Set(), chatCache: new Map(), worldNames: new Set() };

/* ----------------------------- утилиты ----------------------------- */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
const getExt = (n) => (n.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
const stem = (n) => n.replace(/\.[^.]+$/, '');
const fmtSize = (b) => (b < 1024 ? `${b} Б` : b < 1048576 ? `${(b / 1024).toFixed(1)} КБ` : `${(b / 1048576).toFixed(1)} МБ`);

function getSettings() {
    const c = ctx();
    const store = c.extensionSettings ?? (window.__sti_fallback_settings ??= {});
    store[MODULE] ??= {};
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (store[MODULE][k] === undefined) store[MODULE][k] = v;
    }
    return store[MODULE];
}
const saveSettings = () => ctx().saveSettingsDebounced?.();

function headers(forForm = false) {
    const h = { ...ctx().getRequestHeaders() };
    if (forForm) {
        delete h['Content-Type'];
        delete h['content-type'];
    }
    return h;
}

async function parseResponse(res) {
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
    }
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
}
const postForm = async (url, fd) => parseResponse(await fetch(url, { method: 'POST', headers: headers(true), body: fd }));
const postJson = async (url, body) => parseResponse(await fetch(url, { method: 'POST', headers: headers(false), body: JSON.stringify(body) }));

/* ----------------------- определение типа файла ----------------------- */

async function pngHasCard(file) {
    try {
        const buf = new Uint8Array(await file.arrayBuffer());
        if (buf.length < 16 || buf[0] !== 0x89 || buf[1] !== 0x50) return false;
        const dv = new DataView(buf.buffer);
        let p = 8;
        while (p + 12 <= buf.length) {
            const len = dv.getUint32(p);
            const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
            if (type === 'tEXt') {
                let key = '';
                for (let i = p + 8; i < p + 8 + len && buf[i] !== 0; i++) key += String.fromCharCode(buf[i]);
                if (key === 'chara' || key === 'ccv3') return true;
            }
            if (type === 'IEND') break;
            p += 12 + len;
        }
    } catch { /* ignore */ }
    return false;
}

function classifyJson(j) {
    if (!j || typeof j !== 'object' || Array.isArray(j)) return 'skip';
    if (j.personas && typeof j.personas === 'object' && !Array.isArray(j.personas) && ('persona_descriptions' in j || 'default_persona' in j)) return 'persona_backup';
    if (Array.isArray(j.data_visible) || j.histories || (Array.isArray(j.messages) && !('entries' in j))) return 'chat';
    if (j.spec === 'chara_card_v2' || j.spec === 'chara_card_v3') return 'character';
    if ('first_mes' in j || 'char_name' in j || 'char_persona' in j || (j.data && typeof j.data === 'object' && 'first_mes' in j.data)) return 'character';
    if (Array.isArray(j.qrList)) return 'quickreply';
    if ('main_text_color' in j && 'blur_strength' in j) return 'theme';
    if ('entries' in j) return 'world';
    if ('input_sequence' in j && 'output_sequence' in j) return 'preset_instruct';
    if ('story_string' in j) return 'preset_context';
    if ('prefix' in j && 'suffix' in j && 'separator' in j) return 'preset_reasoning';
    if ('prompts' in j || 'prompt_order' in j || 'openai_max_context' in j || 'chat_completion_source' in j) return 'preset_openai';
    if ('tail_free_sampling' in j) return 'preset_novel';
    if ('repetition_penalty' in j || 'min_p' in j || 'mirostat_mode' in j || 'dynatemp' in j) return 'preset_textgen';
    if ('rep_pen' in j || 'sampler_order' in j) return 'preset_kobold';
    if (typeof j.content === 'string' && typeof j.name === 'string' && Object.keys(j).length <= 4) return 'preset_sysprompt';
    return 'skip';
}

async function detect(file) {
    const ext = getExt(file.name);
    if (['charx', 'byaf', 'yaml', 'yml'].includes(ext)) return { type: 'character' };
    if (ext === 'jsonl') return { type: 'chat' };
    if (ext === 'png') return { type: (await pngHasCard(file)) ? 'character' : 'background' };
    if (['jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'].includes(ext)) return { type: 'background' };
    if (ext === 'zip') return { type: 'skip', msg: 'ZIP не поддерживается: распакуйте и добавьте файлы или папку' };
    if (ext === 'json') {
        try {
            const json = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
            const type = classifyJson(json);
            return { type, json, msg: type === 'skip' ? 'Тип не определён — выберите вручную' : '' };
        } catch {
            return { type: 'skip', msg: 'Некорректный JSON' };
        }
    }
    return { type: 'skip', msg: 'Неизвестный формат' };
}

async function getJson(it) {
    if (!it.json) it.json = JSON.parse((await it.file.text()).replace(/^\uFEFF/, ''));
    return it.json;
}

/* ----------------------------- импорт ----------------------------- */


/* ---------------------- отпечатки чатов (защита от дублей) ---------------------- */

function hash53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Отпечаток по числу сообщений + первым/последним трём (автор и начало текста). Не зависит от дат и имени файла. */
function fingerprintMessages(msgs) {
    if (!msgs.length) return null;
    const norm = (m) => `${m.is_user ? 1 : 0}|${String(m.mes ?? '').length}|${String(m.mes ?? '').slice(0, 160)}`;
    const pick = [...msgs.slice(0, 3), ...msgs.slice(-3)];
    return `${msgs.length}:${hash53(pick.map(norm).join('\n'))}`;
}

function parseJsonlMessages(text) {
    const msgs = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
            const o = JSON.parse(t);
            if (o && typeof o === 'object' && 'mes' in o) msgs.push(o);
        } catch { /* битая строка — пропускаем */ }
    }
    return msgs;
}

async function getExistingFingerprints(target) {
    if (state.chatCache.has(target.avatar)) return state.chatCache.get(target.avatar);
    const set = new Set();
    state.chatCache.set(target.avatar, set);

    let names = [];
    try {
        const data = await postJson('/api/characters/chats', { avatar_url: target.avatar });
        const arr = Array.isArray(data) ? data : Object.values(data || {});
        names = arr.map((x) => x?.file_name).filter(Boolean);
    } catch (e) {
        console.warn('[DataImporter] не удалось получить список чатов', e);
    }

    const queue = [...names];
    const worker = async () => {
        while (queue.length) {
            const fn = String(queue.shift()).replace(/\.jsonl$/i, '');
            try {
                const msgs = await postJson('/api/chats/get', { ch_name: target.name, file_name: fn, avatar_url: target.avatar });
                if (Array.isArray(msgs)) {
                    const fp = fingerprintMessages(msgs.filter((m) => m && typeof m === 'object' && 'mes' in m));
                    if (fp) set.add(fp);
                }
            } catch { /* ignore */ }
        }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return set;
}

/* ----------------------------- персоны ----------------------------- */

async function getPowerUser() {
    const c = ctx();
    if (c.powerUserSettings) return c.powerUserSettings;
    try {
        const m = await import('/scripts/power-user.js');
        if (m.power_user) return m.power_user;
    } catch { /* ignore */ }
    throw new Error('Нет доступа к настройкам персон в этой версии ST');
}

async function personaKeySet() {
    const set = new Set();
    for (const it of state.items.filter((i) => i.type === 'persona_backup')) {
        try { Object.keys((await getJson(it)).personas || {}).forEach((k) => set.add(k)); } catch { /* ignore */ }
    }
    return set;
}

async function reclassifyAvatars() {
    const keys = await personaKeySet();
    if (!keys.size) return;
    for (const it of state.items) {
        if (it.status === 'ready' && it.type === 'background' && keys.has(it.file.name)) {
            it.type = 'avatar';
            it.msg = 'Аватар персоны из бэкапа';
        }
    }
    render();
}

async function saveSettingsNow() {
    try {
        const m = await import('/script.js');
        if (typeof m.saveSettings === 'function') return await m.saveSettings();
    } catch { /* ignore */ }
    saveSettings();
}

async function refreshPersonas() {
    await saveSettingsNow();
    try {
        const m = await import('/scripts/personas.js');
        await m.getUserAvatars?.(true);
    } catch { /* без обновления списка — достаточно перезагрузить страницу */ }
}

async function importPersonaBackup(it) {
    const json = await getJson(it);
    if (!json || typeof json.personas !== 'object' || Array.isArray(json.personas)) {
        throw new Error('Это не бэкап персон SillyTavern');
    }
    const pu = await getPowerUser();
    pu.personas ??= {};
    pu.persona_descriptions ??= {};

    const defaults = { description: '', position: 0, depth: 2, role: 0, lorebook: '', title: '' };
    let added = 0, updated = 0;
    for (const [avatar, name] of Object.entries(json.personas)) {
        if (avatar in pu.personas) updated++; else added++;
        pu.personas[avatar] = name;
        const incoming = json.persona_descriptions?.[avatar];
        pu.persona_descriptions[avatar] = {
            ...defaults,
            ...(pu.persona_descriptions[avatar] || {}),
            ...(incoming && typeof incoming === 'object' ? incoming : {}),
        };
    }
    if (json.default_persona && json.default_persona in pu.personas && !pu.default_persona) {
        pu.default_persona = json.default_persona;
    }
    await refreshPersonas();
    return `Персон: новых ${added}, обновлено ${updated}. Картинки аватаров добавьте файлами с теми же именами`;
}

/* ----------------------- привязка лорбуков ----------------------- */

const findKnownWorld = (nm) => nm ? [...state.worldNames].find((k) => k.toLowerCase() === String(nm).trim().toLowerCase()) : undefined;
const safeName = (n) => String(n).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120);

async function loadWorldNames() {
    document.querySelectorAll('#world_info option, #world_editor_select option').forEach((o) => {
        const t = o.textContent.trim();
        if (o.value !== '' && t && !t.startsWith('---')) state.worldNames.add(t);
    });
    if (!state.worldNames.size) {
        try {
            const d = await postJson('/api/settings/get', {});
            (d?.world_names || []).forEach((n) => state.worldNames.add(n));
        } catch { /* ignore */ }
    }
}

async function readCardJson(file) {
    try {
        const ext = getExt(file.name);
        if (ext === 'json') return JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
        if (ext !== 'png') return null;
        const buf = new Uint8Array(await file.arrayBuffer());
        if (buf[0] !== 0x89) return null;
        const dv = new DataView(buf.buffer);
        const found = {};
        let p = 8;
        while (p + 12 <= buf.length) {
            const len = dv.getUint32(p);
            const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
            if (type === 'tEXt') {
                let i = p + 8, key = '';
                while (i < p + 8 + len && buf[i] !== 0) key += String.fromCharCode(buf[i++]);
                if (key === 'chara' || key === 'ccv3') {
                    let b64 = '';
                    for (let k = i + 1; k < p + 8 + len; k++) b64 += String.fromCharCode(buf[k]);
                    found[key] = b64;
                }
            }
            if (type === 'IEND') break;
            p += 12 + len;
        }
        const b64 = found.ccv3 ?? found.chara;
        if (!b64) return null;
        const bytes = Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0));
        return JSON.parse(new TextDecoder('utf-8').decode(bytes));
    } catch { return null; }
}

function cardInfo(card) {
    const d = card?.data && typeof card.data === 'object' ? card.data : card;
    return {
        name: d?.name || card?.name || '',
        world: d?.extensions?.world || card?.extensions?.world || card?.world || '',
        book: d?.character_book || card?.character_book || null,
    };
}

function convertBookToWorld(book) {
    const entries = {};
    (book.entries || []).forEach((e, index) => {
        const ext = e.extensions || {};
        entries[index] = {
            uid: index,
            key: Array.isArray(e.keys) ? e.keys : [],
            keysecondary: Array.isArray(e.secondary_keys) ? e.secondary_keys : [],
            comment: e.comment || e.name || '',
            content: e.content || '',
            constant: !!e.constant,
            selective: e.selective ?? false,
            order: e.insertion_order ?? 100,
            position: ext.position ?? (e.position === 'before_char' ? 0 : 1),
            excludeRecursion: ext.exclude_recursion ?? false,
            preventRecursion: ext.prevent_recursion ?? false,
            delayUntilRecursion: ext.delay_until_recursion ?? false,
            disable: e.enabled === false,
            addMemo: !!(e.comment || e.name),
            displayIndex: ext.display_index ?? index,
            probability: ext.probability ?? 100,
            useProbability: ext.useProbability ?? true,
            depth: ext.depth ?? 4,
            selectiveLogic: ext.selectiveLogic ?? 0,
            group: ext.group ?? '',
            groupOverride: ext.group_override ?? false,
            groupWeight: ext.group_weight ?? 100,
            scanDepth: ext.scan_depth ?? null,
            caseSensitive: ext.case_sensitive ?? null,
            matchWholeWords: ext.match_whole_words ?? null,
            useGroupScoring: ext.use_group_scoring ?? null,
            automationId: ext.automation_id ?? '',
            role: ext.role ?? 0,
            vectorized: ext.vectorized ?? false,
            sticky: ext.sticky ?? null,
            cooldown: ext.cooldown ?? null,
            delay: ext.delay ?? null,
        };
    });
    return { entries };
}

async function createLorebookFromCard(card) {
    const name = safeName(card.world || card.book?.name || card.name || 'Lorebook');
    const existing = findKnownWorld(name);
    if (existing) return existing; // уже есть — не перезаписываем
    const file = new File([JSON.stringify(convertBookToWorld(card.book))], `${name}.json`, { type: 'application/json' });
    const fd = new FormData();
    fd.append('avatar', file);
    const data = await postForm('/api/worldinfo/import', fd);
    const real = data?.name ?? name;
    state.worldNames.add(real);
    return real;
}

async function setCharacterWorld(avatar, worldName) {
    await postJson('/api/characters/merge-attributes', { avatar, data: { extensions: { world: worldName } } });
}

/** Определяет и привязывает мир-лорбук к только что импортированному персонажу. Возвращает имя или null. */
async function bindCharacterLore(it, avatar) {
    const st = getSettings();
    if (it.lore === 'none') return null;
    const card = cardInfo(await readCardJson(it.file));
    let name = null;
    let needWrite = true;

    if (it.lore?.startsWith('n:')) {
        name = it.lore.slice(2);
    } else if (st.autoLore) {
        name = findKnownWorld(card.world) ?? null;
        if (name && name === card.world) needWrite = false; // ST уже привяжет по имени из карточки
        if (!name && !card.world) name = findKnownWorld(card.name) ?? null;
        if (!name && st.embeddedBook && card.book?.entries?.length) name = await createLorebookFromCard(card);
    }
    if (!name) return null;
    if (needWrite || name !== card.world) await setCharacterWorld(avatar, name);
    return name;
}

const stDate = () => {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} @${d.getHours()}h ${d.getMinutes()}m ${d.getSeconds()}s ${d.getMilliseconds()}ms`;
};

async function importCharacter(it) {
    const ext = getExt(it.file.name);
    if (!['png', 'json', 'yaml', 'yml', 'charx', 'byaf'].includes(ext)) {
        throw new Error(`Формат .${ext} не подходит для персонажа (для .jsonl выберите тип «Чат»)`);
    }
    const fd = new FormData();
    fd.append('avatar', it.file);
    fd.append('file_type', ext);
    if (getSettings().preserveName) fd.append('preserve_file_name', 'true');
    const data = await postForm('/api/characters/import', fd);
    if (data?.error) throw new Error('Сервер отклонил файл (неверный формат карточки)');

    let note = data?.file_name ? `Создан: ${data.file_name}` : 'Импортирован';
    if (data?.file_name) {
        try {
            const lore = await bindCharacterLore(it, `${data.file_name}.png`);
            if (lore) note += ` · мир-лорбук: ${lore}`;
        } catch (e) {
            note += ` · лорбук не привязан (${e.message})`;
        }
    }
    return note;
}

async function importWorld(it) {
    const json = await getJson(it).catch(() => null);
    const entries = json?.entries;
    const first = entries && !Array.isArray(entries) ? Object.values(entries)[0] : null;
    const native = entries && !Array.isArray(entries) && (!first || 'uid' in first || 'key' in first);

    if (native) {
        const fd = new FormData();
        fd.append('avatar', it.file);
        const data = await postForm('/api/worldinfo/import', fd);
        const nm = data?.name ?? stem(it.file.name);
        state.worldNames.add(nm);
        return `Мир: ${nm}`;
    }
    // Чужие форматы (NovelAI, Agnai, Risu, character_book) — через штатный импорт интерфейса, там есть конвертеры
    const input = document.getElementById('world_import_file');
    if (!input) throw new Error('Нестандартный формат, а штатный импорт World Info не найден');
    const dt = new DataTransfer();
    dt.items.add(it.file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    state.worldNames.add(stem(it.file.name));
    return 'Передан штатному импортёру World Info (конвертация формата)';
}

async function importPreset(it) {
    const json = await getJson(it);
    const useInner = ['preset_instruct', 'preset_context', 'preset_sysprompt', 'preset_reasoning'].includes(it.type);
    const name = (useInner && typeof json.name === 'string' && json.name.trim()) || stem(it.file.name);
    await postJson('/api/presets/save', { apiId: PRESET_API[it.type], name, preset: json });
    return `Пресет: ${name}`;
}

async function importTheme(it) {
    const json = await getJson(it);
    json.name = (typeof json.name === 'string' && json.name.trim()) || stem(it.file.name);
    await postJson('/api/themes/save', json);
    return `Тема: ${json.name} (применится после перезагрузки)`;
}

async function importQuickReply(it) {
    const json = await getJson(it);
    json.name = (typeof json.name === 'string' && json.name.trim()) || stem(it.file.name);
    await postJson('/api/quick-replies/save', json);
    return `Quick Reply: ${json.name} (после перезагрузки)`;
}

function requireImage(it) {
    if (!(it.file.type || '').startsWith('image/') && !['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'].includes(getExt(it.file.name))) {
        throw new Error('Это не изображение');
    }
}

async function importBackground(it) {
    requireImage(it);
    const fd = new FormData();
    fd.append('avatar', it.file);
    await postForm('/api/backgrounds/upload', fd);
    return 'Фон загружен';
}

async function importAvatar(it) {
    requireImage(it);
    const fd = new FormData();
    fd.append('avatar', it.file);
    const keep = (await personaKeySet()).has(it.file.name);
    if (keep) fd.append('overwrite_name', it.file.name); // имя должно совпасть с ключом в бэкапе персон
    await postForm('/api/avatars/upload', fd);
    return keep ? 'Аватар загружен (привязан к персоне из бэкапа)' : 'Аватар загружен';
}

async function firstLineJson(file) {
    try {
        const head = await file.slice(0, 65536).text();
        return JSON.parse(head.split('\n')[0].replace(/^\uFEFF/, ''));
    } catch { return null; }
}

async function importChat(it) {
    const c = ctx();
    const chars = c.characters || [];
    const isJsonl = getExt(it.file.name) === 'jsonl';
    const text = isJsonl ? (await it.file.text()).replace(/^\uFEFF/, '') : null;
    let target = null;

    if (getSettings().autoMatch && isJsonl) {
        let nm = null;
        try { nm = JSON.parse(text.split('\n')[0])?.character_name; } catch { /* нет заголовка */ }
        if (nm) target = chars.find((ch) => ch.name?.toLowerCase() === String(nm).toLowerCase()) ?? null;
    }
    if (!target) {
        const idx = state.root.querySelector('#sti_char').value;
        target = idx !== '' ? chars[Number(idx)] : null;
    }
    if (!target) throw new Error('Персонаж не найден — выберите его в списке «Чаты → персонаж»');

    let fp = null;
    if (isJsonl) {
        fp = fingerprintMessages(parseJsonlMessages(text));
        if (!fp) throw new Error('В файле нет сообщений');
    } else {
        fp = 'raw:' + hash53(await it.file.text());
    }
    const key = `${target.avatar}|${fp}`;

    if (getSettings().skipDupChats) {
        if (state.chatSeen.has(key)) {
            it.dup = true;
            return `Дубль в этом запуске — пропущено (${target.name})`;
        }
        if (isJsonl) {
            const existing = await getExistingFingerprints(target);
            if (existing.has(fp)) {
                it.dup = true;
                state.chatSeen.add(key);
                return `Такой чат уже есть у «${target.name}» — пропущено`;
            }
        }
    }

    // Лорбук чата хранится в заголовке jsonl: chat_metadata.world_info
    let uploadFile = it.file;
    let loreNote = '';
    if (isJsonl && it.lore !== 'none') {
        const lines = text.split('\n');
        let header = null;
        try {
            const o = JSON.parse(lines[0]);
            if (o && typeof o === 'object' && !('mes' in o)) header = o;
        } catch { /* нет заголовка */ }

        let want = null;
        if (it.lore?.startsWith('n:')) {
            want = it.lore.slice(2);
        } else if (getSettings().autoLore && header?.chat_metadata?.world_info) {
            const k = findKnownWorld(header.chat_metadata.world_info);
            if (k) want = k;
            else loreNote = ` · лорбук чата «${header.chat_metadata.world_info}» не найден`;
        }
        if (want) {
            if (header?.chat_metadata?.world_info !== want) {
                if (header) {
                    header.chat_metadata = { ...(header.chat_metadata || {}), world_info: want };
                    lines[0] = JSON.stringify(header);
                } else {
                    lines.unshift(JSON.stringify({ user_name: c.name1 || 'User', character_name: target.name, create_date: stDate(), chat_metadata: { world_info: want } }));
                }
                uploadFile = new File([lines.join('\n')], it.file.name, { type: 'application/json' });
            }
            loreNote = ` · лорбук чата: ${want}`;
        }
    }

    const fd = new FormData();
    fd.append('avatar', uploadFile);
    fd.append('file_type', isJsonl ? 'jsonl' : 'json');
    fd.append('avatar_url', target.avatar);
    fd.append('character_name', target.name);
    fd.append('user_name', c.name1 || 'User');
    const data = await postForm('/api/chats/import', fd);
    if (data?.error) throw new Error('Сервер отклонил файл чата (неподдерживаемый формат)');

    state.chatSeen.add(key);
    if (isJsonl) state.chatCache.get(target.avatar)?.add(fp);
    return `Чат → ${target.name}${loreNote}`;
}

async function importOne(it) {
    switch (it.type) {
        case 'character': return importCharacter(it);
        case 'world': return importWorld(it);
        case 'chat': return importChat(it);
        case 'theme': return importTheme(it);
        case 'quickreply': return importQuickReply(it);
        case 'background': return importBackground(it);
        case 'avatar': return importAvatar(it);
        case 'persona_backup': return importPersonaBackup(it);
        default:
            if (PRESET_API[it.type]) return importPreset(it);
            throw new Error('Неизвестный тип');
    }
}

async function refreshCharacters() {
    try { await ctx().getCharacters?.(); } catch (e) { console.warn('[DataImporter] getCharacters failed', e); }
    fillCharSelect();
}

async function runImport() {
    if (state.busy) return;
    const queue = state.items
        .filter((i) => i.type !== 'skip' && i.status !== 'ok')
        .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
    if (!queue.length) return toastr.info('Нечего импортировать');

    state.busy = true;
    state.chatSeen = new Set();
    state.chatCache = new Map();
    await loadWorldNames();
    render();
    let ok = 0, fail = 0, dup = 0, charsRefreshed = false;

    for (const it of queue) {
        if (it.type === 'chat' && state.imported.has('character') && !charsRefreshed) {
            await refreshCharacters();
            charsRefreshed = true;
        }
        it.status = 'busy';
        it.msg = '';
        render();
        try {
            it.msg = await importOne(it);
            it.status = 'ok';
            state.imported.add(it.type === 'character' ? 'character' : it.type === 'world' ? 'world' : ['avatar', 'persona_backup'].includes(it.type) ? 'persona' : 'other');
            if (it.dup) dup++; else ok++;
        } catch (e) {
            it.status = 'err';
            it.msg = e?.message || String(e);
            fail++;
            console.error('[DataImporter]', it.file.name, e);
        }
        render();
    }

    if (state.imported.has('character')) await refreshCharacters();
    try { if (state.imported.has('world') || state.worldNames.size) await ctx().updateWorldInfoList?.(); } catch { /* ignore */ }
    render();

    state.busy = false;
    render();
    try { if (state.imported.has('persona')) await refreshPersonas(); } catch { /* ignore */ }
    (fail ? toastr.warning : toastr.success)(`Готово: успешно ${ok}, дублей пропущено ${dup}, ошибок ${fail}`, 'Импортёр данных');
}

/* --------------------- установка расширений (Git) --------------------- */

async function installExtensions() {
    const root = state.root;
    const area = root.querySelector('#sti_ext_urls');
    const log = root.querySelector('#sti_ext_log');
    const isGlobal = root.querySelector('#sti_ext_global').checked;
    const urls = area.value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    if (!urls.length) return toastr.info('Вставьте хотя бы одну ссылку');

    log.innerHTML = '';
    const btn = root.querySelector('#sti_ext_install');
    btn.disabled = true;
    for (const url of urls) {
        const line = document.createElement('div');
        line.textContent = `⏳ ${url}`;
        log.appendChild(line);
        try {
            const data = await postJson('/api/extensions/install', { url, global: isGlobal });
            line.textContent = `✅ ${data?.display_name || url}${data?.version ? ' v' + data.version : ''}`;
            state.imported.add('extension');
        } catch (e) {
            line.textContent = `❌ ${url} — ${e.message}`;
        }
    }
    btn.disabled = false;
    toastr.info('Для активации расширений перезагрузите страницу');
}

/* ------------------------------- UI ------------------------------- */

function fillCharSelect() {
    const sel = state.root?.querySelector('#sti_char');
    if (!sel) return;
    const c = ctx();
    const chars = c.characters || [];
    const prev = sel.value;
    sel.innerHTML = '<option value="">— выберите персонажа —</option>' +
        chars.map((ch, i) => `<option value="${i}">${esc(ch.name)}</option>`).join('');
    const cur = c.characterId;
    if (prev !== '' && chars[Number(prev)]) sel.value = prev;
    else if (cur !== undefined && cur !== null && chars[cur]) sel.value = String(cur);
}

function loreRow(it) {
    const staged = [...new Set(state.items.filter((i) => i.type === 'world').map((i) => stem(i.file.name)))];
    const existing = [...state.worldNames].filter((n) => !staged.includes(n)).sort((a, b) => a.localeCompare(b));
    const opt = (v, label) => `<option value="${esc(v)}"${it.lore === v ? ' selected' : ''}>${esc(label)}</option>`;
    const label = it.type === 'chat' ? 'Лорбук чата:' : 'Мир-лорбук персонажа:';
    return `<div class="sti_lore_wrap"><span>${label}</span>
        <select class="text_pole sti_lore" ${state.busy ? 'disabled' : ''}>
            ${opt('auto', 'Авто (по имени из файла)')}${opt('none', 'Не менять')}
            ${staged.length ? `<optgroup label="Из этого пакета">${staged.map((n) => opt('n:' + n, n)).join('')}</optgroup>` : ''}
            ${existing.length ? `<optgroup label="Уже в SillyTavern">${existing.map((n) => opt('n:' + n, n)).join('')}</optgroup>` : ''}
        </select></div>`;
}

function rowHtml(it) {
    const opts = Object.entries(TYPES)
        .map(([k, v]) => `<option value="${k}"${k === it.type ? ' selected' : ''}>${esc(v)}</option>`).join('');
    const icon = { ready: '', busy: '⏳', ok: '✅', err: '❌' }[it.status];
    return `
    <div class="sti_row sti_${it.status}" data-id="${it.id}">
        <div class="sti_name" title="${esc(it.file.name)}">${esc(it.file.name)}<small>${fmtSize(it.file.size)}</small></div>
        <select class="text_pole sti_type" ${state.busy ? 'disabled' : ''}>${opts}</select>
        <div class="sti_status" title="${esc(it.msg || '')}">${icon} <span>${esc(it.msg || '')}</span></div>
        <div class="sti_rm menu_button fa-solid fa-xmark" title="Убрать из списка"></div>
        ${it.type === 'character' || it.type === 'chat' ? loreRow(it) : ''}
    </div>`;
}

function render() {
    const root = state.root;
    if (!root) return;
    const list = root.querySelector('#sti_list');
    list.innerHTML = state.items.length
        ? state.items.map(rowHtml).join('')
        : '<div class="sti_empty">Файлов пока нет. Перетащите их сюда или нажмите «Выбрать файлы».</div>';
    const pending = state.items.filter((i) => i.type !== 'skip' && i.status !== 'ok').length;
    const btn = root.querySelector('#sti_run');
    btn.textContent = `Импортировать (${pending})`;
    btn.disabled = state.busy || !pending;
    root.querySelector('#sti_clear').disabled = state.busy;
}

async function filesFromDrop(dt) {
    const items = [...(dt.items || [])];
    if (!items.length || typeof items[0].webkitGetAsEntry !== 'function') return [...dt.files];
    const entries = items.map((i) => i.webkitGetAsEntry()).filter(Boolean); // снимаем синхронно
    const out = [];
    const walk = async (e) => {
        if (e.isFile) {
            out.push(await new Promise((res, rej) => e.file(res, rej)));
        } else if (e.isDirectory) {
            const reader = e.createReader();
            let batch;
            do {
                batch = await new Promise((res, rej) => reader.readEntries(res, rej));
                for (const child of batch) await walk(child);
            } while (batch.length);
        }
    };
    for (const e of entries) await walk(e);
    return out;
}

async function addFiles(files) {
    for (const file of files) {
        if (file.name.startsWith('.')) continue;
        const dup = state.items.some((i) => i.file.name === file.name && i.file.size === file.size && i.file.lastModified === file.lastModified);
        if (dup) continue;
        const d = await detect(file);
        state.items.push({ id: state.nextId++, file, type: d.type, json: d.json, status: 'ready', msg: d.msg || '', lore: 'auto' });
        render();
    }
    await reclassifyAvatars();
}

function buildModal() {
    const s = getSettings();
    const el = document.createElement('div');
    el.className = 'sti_overlay';
    el.style.display = 'none';
    el.innerHTML = `
    <div class="sti_modal">
        <div class="sti_head">
            <b>Импортёр данных</b>
            <div class="sti_close menu_button fa-solid fa-xmark" title="Закрыть"></div>
        </div>
        <div class="sti_tabs">
            <div class="sti_tab menu_button active" data-tab="files">Файлы</div>
            <div class="sti_tab menu_button" data-tab="ext">Расширения (Git)</div>
        </div>

        <div class="sti_panel" data-panel="files">
            <div class="sti_drop" id="sti_drop">
                <i class="fa-solid fa-file-import"></i>
                <div>Перетащите сюда файлы или папку<br><small>персонажи (png/json/yaml/charx), лорбуки, чаты (jsonl), пресеты, темы, Quick Reply, фоны</small></div>
                <div class="sti_btns">
                    <div class="menu_button" id="sti_pick_files">Выбрать файлы</div>
                    <div class="menu_button" id="sti_pick_dir">Выбрать папку</div>
                </div>
                <input type="file" id="sti_input_files" multiple hidden>
                <input type="file" id="sti_input_dir" webkitdirectory multiple hidden>
            </div>

            <div class="sti_opts">
                <label class="checkbox_label"><input type="checkbox" id="sti_auto" ${s.autoMatch ? 'checked' : ''}><span>Чаты: подбирать персонажа по имени из файла</span></label>
                <label class="checkbox_label"><input type="checkbox" id="sti_preserve" ${s.preserveName ? 'checked' : ''}><span>Персонажи: сохранять имя файла</span></label>
                <label class="checkbox_label"><input type="checkbox" id="sti_dedupe" ${s.skipDupChats ? 'checked' : ''}><span>Чаты: не создавать дубли (пропускать, если такой чат уже есть у персонажа)</span></label>
                <label class="checkbox_label"><input type="checkbox" id="sti_autolore" ${s.autoLore ? 'checked' : ''}><span>Лорбуки: автопривязка по имени (мир-лорбук к персонажу, лорбук чата к чату)</span></label>
                <label class="checkbox_label"><input type="checkbox" id="sti_embbook" ${s.embeddedBook ? 'checked' : ''}><span>Персонажи: создавать лорбук из встроенной книги карточки и привязывать</span></label>
                <div class="sti_char_wrap"><span>Чаты → персонаж по умолчанию:</span> <select id="sti_char" class="text_pole"></select></div>
            </div>

            <div id="sti_list" class="sti_list"></div>

            <div class="sti_actions">
                <div class="menu_button" id="sti_run">Импортировать (0)</div>
                <div class="menu_button" id="sti_clear">Очистить список</div>
                <div class="menu_button" id="sti_reload" title="Нужно для тем, Quick Reply, фонов и расширений">Перезагрузить страницу</div>
            </div>
        </div>

        <div class="sti_panel" data-panel="ext" hidden>
            <p>Расширения ST устанавливаются из Git-репозиториев. Вставьте ссылки (по одной на строку):</p>
            <textarea id="sti_ext_urls" class="text_pole" rows="6" placeholder="https://github.com/user/SillyTavern-Extension"></textarea>
            <label class="checkbox_label"><input type="checkbox" id="sti_ext_global" ${s.globalInstall ? 'checked' : ''}><span>Установить для всех пользователей (нужны права администратора)</span></label>
            <div class="sti_actions"><div class="menu_button" id="sti_ext_install">Установить</div></div>
            <div id="sti_ext_log" class="sti_log"></div>
            <p class="sti_hint">ZIP-архивы с расширениями загрузить нельзя: в SillyTavern нет API для этого. Распакуйте папку в <code>data/&lt;пользователь&gt;/extensions/</code> вручную.</p>
        </div>
    </div>`;
    document.body.appendChild(el);
    state.root = el;

    const q = (sel) => el.querySelector(sel);

    q('.sti_close').addEventListener('click', closeModal);
    el.addEventListener('mousedown', (e) => { if (e.target === el) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el.style.display !== 'none') closeModal(); });

    el.querySelectorAll('.sti_tab').forEach((t) => t.addEventListener('click', () => {
        el.querySelectorAll('.sti_tab').forEach((x) => x.classList.toggle('active', x === t));
        el.querySelectorAll('.sti_panel').forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
    }));

    const drop = q('#sti_drop');
    // SillyTavern сам ловит drag&drop на всей странице (импорт персонажей/аватаров).
    // Перехватываем события в capture-фазе на window и не пускаем их дальше, пока открыто наше окно.
    const dndGuard = async (e) => {
        if (el.style.display === 'none' || !el.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (e.type === 'dragenter' || e.type === 'dragover') {
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            drop.classList.add('over');
        } else if (e.type === 'dragleave') {
            drop.classList.remove('over');
        } else if (e.type === 'drop') {
            drop.classList.remove('over');
            await addFiles(await filesFromDrop(e.dataTransfer));
        }
    };
    for (const t of ['dragenter', 'dragover', 'dragleave', 'drop']) window.addEventListener(t, dndGuard, true);
    q('#sti_pick_files').addEventListener('click', () => q('#sti_input_files').click());
    q('#sti_pick_dir').addEventListener('click', () => q('#sti_input_dir').click());
    for (const id of ['#sti_input_files', '#sti_input_dir']) {
        q(id).addEventListener('change', async (e) => {
            await addFiles([...e.target.files]);
            e.target.value = '';
        });
    }

    q('#sti_auto').addEventListener('change', (e) => { getSettings().autoMatch = e.target.checked; saveSettings(); });
    q('#sti_autolore').addEventListener('change', (e) => { getSettings().autoLore = e.target.checked; saveSettings(); });
    q('#sti_embbook').addEventListener('change', (e) => { getSettings().embeddedBook = e.target.checked; saveSettings(); });
    q('#sti_dedupe').addEventListener('change', (e) => { getSettings().skipDupChats = e.target.checked; saveSettings(); });
    q('#sti_preserve').addEventListener('change', (e) => { getSettings().preserveName = e.target.checked; saveSettings(); });
    q('#sti_ext_global').addEventListener('change', (e) => { getSettings().globalInstall = e.target.checked; saveSettings(); });

    q('#sti_list').addEventListener('change', (e) => {
        if (e.target.classList.contains('sti_lore')) {
            const li = state.items.find((i) => i.id === Number(e.target.closest('.sti_row').dataset.id));
            if (li) li.lore = e.target.value;
            return;
        }
        if (!e.target.classList.contains('sti_type')) return;
        const it = state.items.find((i) => i.id === Number(e.target.closest('.sti_row').dataset.id));
        if (it) { it.type = e.target.value; if (it.status === 'err') it.status = 'ready'; it.msg = ''; render(); reclassifyAvatars(); }
    });
    q('#sti_list').addEventListener('click', (e) => {
        const rm = e.target.closest('.sti_rm');
        if (!rm || state.busy) return;
        const id = Number(rm.closest('.sti_row').dataset.id);
        state.items = state.items.filter((i) => i.id !== id);
        render();
    });

    q('#sti_run').addEventListener('click', runImport);
    q('#sti_clear').addEventListener('click', () => { state.items = []; render(); });
    q('#sti_reload').addEventListener('click', () => location.reload());
    q('#sti_ext_install').addEventListener('click', installExtensions);

    render();
}

function openModal() {
    if (!state.root) buildModal();
    fillCharSelect();
    loadWorldNames().then(render);
    state.root.style.display = 'flex';
}
function closeModal() {
    if (state.root) state.root.style.display = 'none';
}

jQuery(() => {
    const panel = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Data Importer (Импортёр данных)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <small>Массовый импорт персонажей, лорбуков, чатов, пресетов, тем, Quick Reply, фонов, а также установка расширений по Git-ссылкам.</small>
            <div class="menu_button" id="sti_open" style="margin-top:8px;"><i class="fa-solid fa-file-import"></i>&nbsp;Открыть импортёр</div>
        </div>
    </div>`;
    jQuery('#extensions_settings2, #extensions_settings').first().append(panel);
    jQuery('#sti_open').on('click', openModal);

    jQuery('#extensionsMenu').append(`
        <div id="sti_wand_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-file-import extensionsMenuExtensionButton"></div>
            <span>Импортёр данных</span>
        </div>`);
    jQuery('#sti_wand_button').on('click', openModal);

    console.log('[DataImporter] loaded');
});
