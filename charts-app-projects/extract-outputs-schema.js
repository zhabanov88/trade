/**
 * extract-outputs-schema.js
 *
 * Извлекает outputs_schema из кода TVEngine индикатора.
 * Ищет поля которые индикатор пишет в activedata / bar объект.
 *
 * Паттерны которые ищем:
 *   1. ad[...].FIELDNAME = ...        (запись в activedata по индексу)
 *   2. ad[adIdx].FIELDNAME = ...
 *   3. bar.FIELDNAME = ...            (прямая запись в бар)
 *   4. activedata[...].FIELDNAME = ...
 *   5. Комментарии вида:
 *        //   FIELDNAME — описание
 *        //   FIELDNAME (type) — описание
 *      в блоке §22 или "ACTIVEDATA" или "activedata"
 */

'use strict';

// Базовые поля бара — не считаем outputs
const BASE_BAR_FIELDS = new Set([
    't','o','h','l','c','v',
    'open','high','low','close','volume',
    'timestamp','time','tf_up','tf_down',
    'first_tick_index','last_tick_index',
]);

/**
 * Главная функция.
 * @param {string} code - код индикатора
 * @returns {Array} outputs_schema
 */
function extractOutputsSchema(code) {
    if (!code || typeof code !== 'string') return [];

    const found = new Map(); // id → { id, name, type, description }

    // ── 1. Паттерн: запись в activedata объект ─────────────────────────────
    // ad[...].FIELDNAME = ...  или  ad[i].FIELDNAME =
    // activedata[...].FIELDNAME =
    const adWritePattern = /\b(?:ad|activedata)\s*\[[^\]]*\]\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
    let m;
    while ((m = adWritePattern.exec(code)) !== null) {
        const key = m[1];
        if (!BASE_BAR_FIELDS.has(key) && key.length > 1) {
            if (!found.has(key)) {
                found.set(key, {
                    id:          key,
                    name:        keyToName(key),
                    type:        guessType(key),
                    description: '',
                });
            }
        }
    }

    // ── 2. Паттерн: запись bar.FIELDNAME = ────────────────────────────────
    const barWritePattern = /\bbar\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
    while ((m = barWritePattern.exec(code)) !== null) {
        const key = m[1];
        if (!BASE_BAR_FIELDS.has(key) && key.length > 1) {
            if (!found.has(key)) {
                found.set(key, {
                    id:          key,
                    name:        keyToName(key),
                    type:        guessType(key),
                    description: '',
                });
            }
        }
    }

    // ── 3. Парсинг блоков комментариев с описаниями полей ─────────────────
    // Ищем блоки вида:
    //   §22 ... ACTIVEDATA ...
    //   // Fields written:
    //   //   FIELDNAME — description
    //   //   FIELDNAME (type) — description
    parseCommentBlocks(code, found);

    const result = Array.from(found.values()).filter(o => o.id.length > 1);

    if (result.length > 0) {
        console.log('[extractOutputsSchema] found:', result.map(o => o.id).join(', '));
    }

    return result;
}

/**
 * Парсим блоки комментариев чтобы найти описания полей.
 * Ищем паттерн:
 *   //   FIELDNAME — description
 *   //   FIELDNAME (type): description
 * внутри блоков которые упоминают activedata / §22 / Fields written
 */
function parseCommentBlocks(code, found) {
    const lines = code.split('\n');

    // Находим строки которые начинают "описательный блок"
    // (упоминают activedata, §22, Fields written, writes ... fields)
    const blockStartRe = /activedata|§\s*22|fields\s+written|writes?\s+.*fields?/i;

    // Паттерн для строки вида:   //   FIELDNAME — description
    // Где FIELDNAME — ALL_CAPS или camelCase или UPPERCASE_WITH_UNDERSCORES
    // начинается с буквы, содержит буквы/цифры/подчёркивания
    const fieldLineRe = /^[\s/*]+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*[-—:]\s*(.+)$/;

    // Паттерн для простой строки с идентификатором без описания:
    //   //   FIELDNAME,
    //   //   FIELDNAME (type).
    const simpleFieldRe = /^[\s/*]+([A-Z][A-Z0-9_]{2,})\s*[,.]?\s*(?:\(([^)]*)\))?\s*$/;

    let inBlock = false;
    let blockDepth = 0; // сколько строк ещё в блоке

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Проверяем начало блока
        if (blockStartRe.test(line)) {
            inBlock = true;
            blockDepth = 0;
            continue;
        }

        if (inBlock) {
            blockDepth++;
            // Выходим из блока если встретили пустую строку или строку без комментария
            // после 30 строк контекста
            if (blockDepth > 40) { inBlock = false; continue; }

            // Пустая строка или конец блока комментариев
            if (/^\s*$/.test(line) && blockDepth > 5) { inBlock = false; continue; }

            // Пробуем распарсить строку как описание поля
            let fm = fieldLineRe.exec(line);
            if (fm) {
                const key = fm[1];
                const typeHint = fm[2] || '';
                const desc = (fm[3] || '').trim();
                if (!BASE_BAR_FIELDS.has(key) && key.length > 1) {
                    const existing = found.get(key);
                    if (existing) {
                        // Обновляем описание если нашли в комментарии
                        if (desc) existing.description = desc;
                        if (typeHint) existing.type = normalizeType(typeHint);
                    } else {
                        found.set(key, {
                            id:          key,
                            name:        keyToName(key),
                            type:        typeHint ? normalizeType(typeHint) : guessType(key),
                            description: desc,
                        });
                    }
                }
                continue;
            }

            // Простой вариант — только имя поля заглавными буквами
            fm = simpleFieldRe.exec(line);
            if (fm) {
                const key = fm[1];
                const typeHint = fm[2] || '';
                if (!BASE_BAR_FIELDS.has(key) && key.length > 1) {
                    if (!found.has(key)) {
                        found.set(key, {
                            id:          key,
                            name:        keyToName(key),
                            type:        typeHint ? normalizeType(typeHint) : guessType(key),
                            description: '',
                        });
                    }
                }
            }
        }
    }
}

/**
 * Превращает snake_case или UPPER_CASE в читаемое имя.
 * CISD_level → "CISD Level"
 * confirmClose → "Confirm Close"
 */
function keyToName(key) {
    // Разбиваем по _ и camelCase границам
    const words = key
        .replace(/([a-z])([A-Z])/g, '$1_$2')  // camelCase → snake_case
        .split('_')
        .filter(Boolean);

    return words.map(word => {
        // Аббревиатура: все заглавные, 2+ символов (CISD, SR, MTF, HTF)
        if (word === word.toUpperCase() && word.length >= 2 && /^[A-Z]+$/.test(word)) {
            return word;
        }
        // Обычное слово — Title Case
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }).join(' ');
}

/**
 * Определяет тип по имени поля.
 */
function guessType(key) {
    const lower = key.toLowerCase();
    if (lower.endsWith('_confirmed') || lower.startsWith('is_') ||
        lower.includes('confirmed') || lower.includes('active') ||
        lower.includes('valid') || lower.includes('signal') ||
        lower.includes('_dir') || lower === 'dir') {
        return 'number'; // 0/1 или -1/0/1
    }
    if (lower.includes('color') || lower.includes('style') || lower.includes('text')) {
        return 'string';
    }
    if (lower.includes('level') || lower.includes('price') ||
        lower.includes('close') || lower.includes('open') ||
        lower.includes('high') || lower.includes('low') ||
        lower.includes('value') || lower.includes('avg')) {
        return 'number';
    }
    return 'number'; // default
}

/**
 * Нормализует строку типа из комментария.
 * "price" → "number", "bool" → "boolean", "0/1" → "number"
 */
function normalizeType(hint) {
    const h = hint.toLowerCase().trim();
    if (h === 'bool' || h === 'boolean') return 'boolean';
    if (h === 'string' || h === 'text' || h === 'color') return 'string';
    if (h === 'price' || h === 'float' || h === 'int' ||
        h === 'integer' || h === 'number' || h.includes('/')) return 'number';
    return 'number';
}

module.exports = { extractOutputsSchema };