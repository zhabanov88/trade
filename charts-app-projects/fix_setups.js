#!/usr/bin/env node
/**
 * fix_setups.js
 * Запуск: node fix_setups.js
 * Путь: /opt/trade/charts-app-projects/fix_setups.js
 */
'use strict';
const { Pool } = require('pg');

const pool = new Pool({
    host:     process.env.GP_HOST     || 'greenplum-db',
    port:     parseInt(process.env.GP_PORT || '5432'),
    database: process.env.GP_DATABASE || 'postgres',
    user:     process.env.GP_USER     || 'gpadmin',
    password: process.env.GP_PASSWORD || 'GreenPlum',
});

// Правила из /config.json Tradeview Advanced:
//   rb_dir = 1 → медвежий бар (close < open, движение вниз)
//   rb_dir = 2 → бычий бар   (close > open, движение вверх)
//
//   "delta > 94" → rb_prev_delta (дельта предыдущего бара):
//     - Медвежий бар: delta отрицательная (ask_sz - bid_sz < 0)
//       → условие для SHORT: rb_prev_delta < -(delta_threshold)
//     - Бычий бар: delta отрицательная тоже (поствход после медвежьего)
//       → условие для LONG: rb_prev_delta < -(delta_threshold)
//
//   "net gex [vol]" = gex_sum_vol:
//     - 01_negtrend_short: < -4  (отрицательный GEX объём)
//     - 01_postrend_long:  > +4  (положительный GEX объём)
//     - 01_postrend_short: > +4  (положительный GEX объём)

const SETUPS = [
    {
        id: 102,
        name: '01 Negtrend SHORT',
        // Медвежий тренд: spot ниже zero_gamma, GEX vol отрицательный
        entry_expression: [
            'bar.rb_dir === 1',
            '&& bar.gex_has_data === 1',
            '&& bar.rb_prev_delta < -(params.delta_threshold)',
            '&& bar.gex_sum_vol < -(params.gex_vol_thresh)',
            '&& bar.gex_spot < (bar.gex_zero_gamma - 5)',
            '&& bar.gex_spot > bar.gex_major_neg',
        ].join('\n'),
        exit_expression: 'bar.rb_dir === 2',
        params_schema: [
            { id: 'delta_threshold', name: 'Delta порог (abs)', type: 'integer', defval: 94 },
            { id: 'gex_vol_thresh',  name: 'GEX Vol порог (abs)', type: 'integer', defval: 4 },
            { id: 'cancel_ticks',    name: 'Cancel ticks', type: 'integer', defval: 10 },
        ],
    },
    {
        id: 103,
        name: '01 Postrend LONG',
        // Пост-тренд бычий: spot выше zero_gamma, GEX vol положительный
        entry_expression: [
            'bar.rb_dir === 2',
            '&& bar.gex_has_data === 1',
            '&& bar.rb_prev_delta < -(params.delta_threshold)',
            '&& bar.gex_sum_vol > params.gex_vol_thresh',
            '&& bar.gex_sum_oi >= 0',
            '&& bar.gex_spot > (bar.gex_zero_gamma + 5)',
            '&& bar.gex_spot < bar.gex_major_pos',
        ].join('\n'),
        exit_expression: 'bar.rb_dir === 1',
        params_schema: [
            { id: 'delta_threshold', name: 'Delta порог (abs)', type: 'integer', defval: 94 },
            { id: 'gex_vol_thresh',  name: 'GEX Vol порог', type: 'integer', defval: 4 },
            { id: 'cancel_ticks',    name: 'Cancel ticks', type: 'integer', defval: 10 },
        ],
    },
    {
        id: 104,
        name: '01 Postrend SHORT',
        // Пост-тренд медвежий: spot выше zero_gamma, GEX vol положительный, OI отрицательный
        entry_expression: [
            'bar.rb_dir === 1',
            '&& bar.gex_has_data === 1',
            '&& bar.rb_prev_delta < -(params.delta_threshold)',
            '&& bar.gex_sum_vol > params.gex_vol_thresh',
            '&& bar.gex_sum_oi <= 0',
            '&& bar.gex_spot > (bar.gex_zero_gamma + 5)',
            '&& bar.gex_spot < bar.gex_major_pos',
        ].join('\n'),
        exit_expression: 'bar.rb_dir === 2',
        params_schema: [
            { id: 'delta_threshold', name: 'Delta порог (abs)', type: 'integer', defval: 94 },
            { id: 'gex_vol_thresh',  name: 'GEX Vol порог', type: 'integer', defval: 4 },
            { id: 'cancel_ticks',    name: 'Cancel ticks', type: 'integer', defval: 10 },
        ],
    },
];

async function main() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (const setup of SETUPS) {
            // Читаем текущий meta
            const { rows } = await client.query(
                'SELECT meta FROM javascript_scripts WHERE id = $1',
                [setup.id]
            );
            if (!rows.length) {
                console.error(`ERROR: id=${setup.id} not found`);
                continue;
            }

            // meta уже объект (pg парсит jsonb автоматически)
            const meta = rows[0].meta || {};

            // Обновляем нужные ключи
            meta.entry_expression = setup.entry_expression;
            meta.exit_expression  = setup.exit_expression;
            meta.params_schema    = setup.params_schema;

            // Сохраняем — передаём как строку с явным кастом ::jsonb
            const result = await client.query(
                `UPDATE javascript_scripts
                 SET meta = $1::jsonb, updated_at = NOW()
                 WHERE id = $2`,
                [JSON.stringify(meta), setup.id]
            );
            console.log(`id=${setup.id} (${setup.name}): ${result.rowCount} row(s) updated`);
        }

        await client.query('COMMIT');
        console.log('\nAll updates committed.\n');

        // Верификация
        const { rows: check } = await client.query(`
            SELECT
                id,
                display_name,
                meta->>'entry_expression'               AS entry_expr,
                meta->>'exit_expression'                AS exit_expr,
                jsonb_array_length(meta->'params_schema') AS params_count,
                meta->'params_schema'->0->>'defval'     AS delta_defval,
                meta->'params_schema'->1->>'defval'     AS vol_defval,
                meta->'params_schema'->2->>'defval'     AS cancel_defval
            FROM javascript_scripts
            WHERE id IN (102, 103, 104)
            ORDER BY id
        `);

        console.log('=== VERIFICATION ===');
        for (const r of check) {
            const ok_delta  = r.delta_defval  === '94';
            const ok_vol    = r.vol_defval    === '4';
            const ok_cancel = r.cancel_defval === '10';
            const ok_params = parseInt(r.params_count) === 3;
            const ok_entry  = (r.entry_expr || '').includes('rb_prev_delta < -(params.delta_threshold)');
            const ok_exit   = (r.exit_expr  || '').includes('bar.rb_dir');

            console.log(`\nid=${r.id} (${r.display_name})`);
            console.log(`  entry_expr:    ${ok_entry  ? '✅' : '❌'} ${(r.entry_expr||'').slice(0,60)}...`);
            console.log(`  exit_expr:     ${ok_exit   ? '✅' : '❌'} ${r.exit_expr}`);
            console.log(`  params_count:  ${ok_params ? '✅' : '❌'} ${r.params_count}`);
            console.log(`  delta_defval:  ${ok_delta  ? '✅' : '❌'} ${r.delta_defval}`);
            console.log(`  vol_defval:    ${ok_vol    ? '✅' : '❌'} ${r.vol_defval}`);
            console.log(`  cancel_defval: ${ok_cancel ? '✅' : '❌'} ${r.cancel_defval}`);

            if (!ok_delta || !ok_vol || !ok_cancel || !ok_params || !ok_entry || !ok_exit) {
                console.log(`  ⚠️  FAIL — данные не обновились!`);
            } else {
                console.log(`  ✅ OK`);
            }
        }

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('ERROR:', err.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

main();