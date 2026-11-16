/**
 * Data Importer for SillyTavern
 * Массовый импорт: персонажи, лорбуки/миры, чаты, пресеты, темы, Quick Reply,
 * фоны, аватары персон, а также установка расширений по Git-ссылкам.
 * Тип файла определяется автоматически, его можно поменять вручную.
 */

const MODULE = 'st_data_importer';
const ctx = () => SillyTavern.getContext();

const defaultSettings = { autoMatch: true, preserveName: false, globalInstall: false };

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
    'character', 'world',
    'preset_openai', 'preset_textgen', 'preset_kobold', 'preset_novel',
    'preset_instruct', 'preset_context', 'preset_sysprompt', 'preset_reasoning',
    'theme', 'quickreply', 'background', 'avatar', 'chat',
];

const state = { items: [], nextId: 1, busy: false, imported: new Set(), root: null };

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

async function importCharacter(it) {
    const fd = new FormData();
    fd.append('avatar', it.file);
    fd.append('file_type', getExt(it.file.name));
    if (getSettings().preserveName) fd.append('preserve_file_name', 'true');
    const data = await postForm('/api/characters/import', fd);
    if (data?.error) throw new Error('Сервер отклонил файл (неверный формат карточки)');
    return data?.file_name ? `Создан: ${data.file_name}` : 'Импортирован';
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
        return `Мир: ${data?.name ?? stem(it.file.name)}`;
    }
    // Чужие форматы (NovelAI, Agnai, Risu, character_book) — через штатный импорт интерфейса, там есть конвертеры
    const input = document.getElementById('world_import_file');
    if (!input) throw new Error('Нестандартный формат, а штатный импорт World Info не найден');
    const dt = new DataTransfer();
    dt.items.add(it.file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
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

async function importBackground(it) {
    const fd = new FormData();
    fd.append('avatar', it.file);
    await postForm('/api/backgrounds/upload', fd);
    return 'Фон загружен';
}

async function importAvatar(it) {
    const fd = new FormData();
    fd.append('avatar', it.file);
    await postForm('/api/avatars/upload', fd);
    return 'Аватар загружен';
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
    let target = null;

    if (getSettings().autoMatch && getExt(it.file.name) === 'jsonl') {
        const header = await firstLineJson(it.file);
        const nm = header?.character_name;
        if (nm) target = chars.find((ch) => ch.name?.toLowerCase() === String(nm).toLowerCase()) ?? null;
    }
    if (!target) {
        const idx = state.root.querySelector('#sti_char').value;
        target = idx !== '' ? chars[Number(idx)] : null;
    }
    if (!target) throw new Error('Персонаж не найден — выберите его в списке «Чаты → персонаж»');

    const fd = new FormData();
    fd.append('avatar', it.file);
    fd.append('file_type', getExt(it.file.name) === 'jsonl' ? 'jsonl' : 'json');
    fd.append('avatar_url', target.avatar);
    fd.append('character_name', target.name);
    fd.append('user_name', c.name1 || 'User');
    const data = await postForm('/api/chats/import', fd);
    if (data?.error) throw new Error('Сервер отклонил файл чата (неподдерживаемый формат)');
    return `Чат → ${target.name}`;
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
    render();
    let ok = 0, fail = 0, charsRefreshed = false;

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
            state.imported.add(it.type === 'character' ? 'character' : it.type === 'world' ? 'world' : 'other');
            ok++;
        } catch (e) {
            it.status = 'err';
            it.msg = e?.message || String(e);
            fail++;
            console.error('[DataImporter]', it.file.name, e);
        }
        render();
    }

    if (state.imported.has('character')) await refreshCharacters();
    try { if (state.imported.has('world')) await ctx().updateWorldInfoList?.(); } catch { /* ignore */ }

    state.busy = false;
    render();
    (fail ? toastr.warning : toastr.success)(`Готово: успешно ${ok}, ошибок ${fail}`, 'Импортёр данных');
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
        state.items.push({ id: state.nextId++, file, type: d.type, json: d.json, status: 'ready', msg: d.msg || '' });
        render();
    }
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
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        await addFiles(await filesFromDrop(e.dataTransfer));
    });
    q('#sti_pick_files').addEventListener('click', () => q('#sti_input_files').click());
    q('#sti_pick_dir').addEventListener('click', () => q('#sti_input_dir').click());
    for (const id of ['#sti_input_files', '#sti_input_dir']) {
        q(id).addEventListener('change', async (e) => {
            await addFiles([...e.target.files]);
            e.target.value = '';
        });
    }

    q('#sti_auto').addEventListener('change', (e) => { getSettings().autoMatch = e.target.checked; saveSettings(); });
    q('#sti_preserve').addEventListener('change', (e) => { getSettings().preserveName = e.target.checked; saveSettings(); });
    q('#sti_ext_global').addEventListener('change', (e) => { getSettings().globalInstall = e.target.checked; saveSettings(); });

    q('#sti_list').addEventListener('change', (e) => {
        if (!e.target.classList.contains('sti_type')) return;
        const it = state.items.find((i) => i.id === Number(e.target.closest('.sti_row').dataset.id));
        if (it) { it.type = e.target.value; if (it.status === 'err') it.status = 'ready'; it.msg = ''; render(); }
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
