'use strict';

/**
 * bot32-ingest-ws.js  v1.0
 *
 * WebSocket сервер — принимает телеметрию от gextrader (протокол v1)
 * и сохраняет в ClickHouse.
 *
 * Протокол (конверт):
 *   {"v":1,"seq":<long>,"event":"<discriminator>","ts_utc":<long>, ...payload...}
 *
 * Supported events:
 *   tick, bar, gex_snapshot, orderflow, market,
 *   decision, safety, position, heartbeat
 *
 * Запуск:
 *   node bot32-ingest-ws.js
 *
 * Env:
 *   WS_PORT         — порт WebSocket (default: 8765)
 *   CH_HOST         — http://clickhouse:8123
 *   CH_USER         — default
 *   CH_PASSWORD     — ...
 *   CH_DATABASE     — default
 *   ACK_INTERVAL_MS — как часто слать ack (default: 200 мс)
 */

const WebSocket = require('ws');
const { createClient } = require('@clickhouse/client');

// ─── конфиг ───────────────────────────────────────────────────────────────────
const WS_PORT        = parseInt(process.env.WS_PORT        || '8765', 10);
const ACK_INTERVAL   = parseInt(process.env.ACK_INTERVAL_MS|| '200',  10);
const CH_HOST        = process.env.CH_HOST     || 'http://clickhouse:8123';
const CH_USER        = process.env.CH_USER     || 'default';
const CH_PASSWORD    = process.env.CH_PASSWORD || 'CL4ICLIsdf4HOUOUSE';
const CH_DATABASE    = process.env.CH_DATABASE || 'default';

// ─── ClickHouse клиент ────────────────────────────────────────────────────────
const ch = createClient({
    host:     CH_HOST,
    username: CH_USER,
    password: CH_PASSWORD,
    database: CH_DATABASE,
});

// ─── DDL — таблицы создаются при старте если не существуют ───────────────────
const DDL = [

// tick / bar → raw_market_data (уже существует, пишем в неё)
// Дополнительные события — отдельные таблицы

`CREATE TABLE IF NOT EXISTS gex_telemetry_ticks (
    seq            UInt64,
    ts_utc         DateTime64(3, 'UTC'),
    data_ts        DateTime64(3, 'UTC'),
    instrument     LowCardinality(String),
    price          Float64,
    volume         Int64,
    at_ask         UInt8
) ENGINE = MergeTree()
ORDER BY (instrument, data_ts)
PARTITION BY toYYYYMM(data_ts)`,

`CREATE TABLE IF NOT EXISTS gex_telemetry_bars (
    seq            UInt64,
    ts_utc         DateTime64(3, 'UTC'),
    bar_start      DateTime64(3, 'UTC'),
    instrument     LowCardinality(String),
    open           Float64,
    high           Float64,
    low            Float64,
    close          Float64,
    volume         Int64
) ENGINE = MergeTree()
ORDER BY (instrument, bar_start)
PARTITION BY toYYYYMM(bar_start)`,

`CREATE TABLE IF NOT EXISTS gex_telemetry_gex_snapshots (
    seq            UInt64,
    ts_utc         DateTime64(3, 'UTC'),
    data_ts        DateTime64(3, 'UTC'),
    ticker         LowCardinality(String),
    level          LowCardinality(String),
    category       LowCardinality(String),
    fields_json    String          -- весь fields-объект как JSON-строка
) ENGINE = MergeTree()
ORDER BY (ticker, level, category, data_ts)
PARTITION BY toYYYYMM(data_ts)`,

`CREATE TABLE IF NOT EXISTS gex_telemetry_orderflow (
    seq                    UInt64,
    ts_utc                 DateTime64(3, 'UTC'),
    cur_delta              Int64,
    cur_total_volume       Int64,
    cur_delta_percent      Float64,
    prev_delta             Int64,
    prev_total_volume      Int64,
    prev_delta_percent     Float64,
    footprint_json         String
) ENGINE = MergeTree()
ORDER BY ts_utc
PARTITION BY toYYYYMM(ts_utc)`,

`CREATE TABLE IF NOT EXISTS gex_telemetry_market (
    seq            UInt64,
    ts_utc         DateTime64(3, 'UTC'),
    instrument     LowCardinality(String),
    last           Nullable(Float64),
    bid            Nullable(Float64),
    ask            Nullable(Float64),
    bar_close      Nullable(Float64)
) ENGINE = MergeTree()
ORDER BY (instrument, ts_utc)
PARTITION BY toYYYYMM(ts_utc)`,

`CREATE TABLE IF NOT EXISTS gex_telemetry_decisions (
    seq                  UInt64,
    ts_utc               DateTime64(3, 'UTC'),
    entry_action         Nullable(String),
    exit_action          Nullable(String),
    matched_entry_rule   Nullable(String),
    matched_exit_rule    Nullable(String),
    flatten              UInt8,
    executable           UInt8,
    suppressed_by        Nullable(String)
) ENGINE = MergeTree()
ORDER BY ts_utc
PARTITION BY toYYYYMM(ts_utc)`,

`CREATE TABLE IF NOT EXISTS gex_telemetry_safety (
    seq               UInt64,
    ts_utc            DateTime64(3, 'UTC'),
    entries_allowed   UInt8,
    should_flatten    UInt8,
    executable        UInt8,
    cause             String,
    causes_json       String
) ENGINE = MergeTree()
ORDER BY ts_utc
PARTITION BY toYYYYMM(ts_utc)`,

`CREATE TABLE IF NOT EXISTS gex_telemetry_positions (
    seq            UInt64,
    ts_utc         DateTime64(3, 'UTC'),
    instrument     LowCardinality(String),
    side           LowCardinality(String),
    quantity       Int64,
    avg_price      Float64,
    realized_pnl   Float64
) ENGINE = MergeTree()
ORDER BY (instrument, ts_utc)
PARTITION BY toYYYYMM(ts_utc)`,

`CREATE TABLE IF NOT EXISTS gex_telemetry_heartbeats (
    seq              UInt64,
    ts_utc           DateTime64(3, 'UTC'),
    instrument       LowCardinality(String),
    status           String,
    ruleset_version  String,
    dropped          Int64
) ENGINE = MergeTree()
ORDER BY ts_utc`,

];

// ─── helper: epoch ms → ClickHouse DateTime64 строка ─────────────────────────
function msToDateTime64(ms) {
    if (ms == null || isNaN(ms)) return null;
    const d = new Date(Number(ms));
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ` +
           `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

function nullable(v) {
    return (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) ? null : v;
}

// ─── буферизация — батчим перед INSERT ───────────────────────────────────────
const FLUSH_INTERVAL = 500; // мс
const FLUSH_MAX      = 500; // строк

const buffers = {
    tick:         [],
    bar:          [],
    gex_snapshot: [],
    orderflow:    [],
    market:       [],
    decision:     [],
    safety:       [],
    position:     [],
    heartbeat:    [],
};

// ─── INSERT по таблицам ───────────────────────────────────────────────────────
async function flushTicks(rows) {
    if (!rows.length) return;
    await ch.insert({
        table: 'gex_telemetry_ticks',
        values: rows,
        format: 'JSONEachRow',
    });
}

async function flushBars(rows) {
    if (!rows.length) return;
    await ch.insert({
        table: 'gex_telemetry_bars',
        values: rows,
        format: 'JSONEachRow',
    });
}

async function flushGexSnapshots(rows) {
    if (!rows.length) return;
    await ch.insert({
        table: 'gex_telemetry_gex_snapshots',
        values: rows,
        format: 'JSONEachRow',
    });
}

async function flushOrderflow(rows) {
    if (!rows.length) return;
    await ch.insert({
        table: 'gex_telemetry_orderflow',
        values: rows,
        format: 'JSONEachRow',
    });
}

async function flushMarket(rows) {
    if (!rows.length) return;
    await ch.insert({
        table: 'gex_telemetry_market',
        values: rows,
        format: 'JSONEachRow',
    });
}

async function flushDecisions(rows) {
    if (!rows.length) return;
    await ch.insert({
        table: 'gex_telemetry_decisions',
        values: rows,
        format: 'JSONEachRow',
    });
}

async function flushSafety(rows) {
    if (!rows.length) return;
    await ch.insert({
        table: 'gex_telemetry_safety',
        values: rows,
        format: 'JSONEachRow',
    });
}

async function flushPositions(rows) {
    if (!rows.length) return;
    await ch.insert({
        table: 'gex_telemetry_positions',
        values: rows,
        format: 'JSONEachRow',
    });
}

async function flushHeartbeats(rows) {
    if (!rows.length) return;
    await ch.insert({
        table: 'gex_telemetry_heartbeats',
        values: rows,
        format: 'JSONEachRow',
    });
}

// ─── периодический flush всех буферов ────────────────────────────────────────
async function flushAll() {
    const tasks = [
        { key: 'tick',         fn: flushTicks },
        { key: 'bar',          fn: flushBars },
        { key: 'gex_snapshot', fn: flushGexSnapshots },
        { key: 'orderflow',    fn: flushOrderflow },
        { key: 'market',       fn: flushMarket },
        { key: 'decision',     fn: flushDecisions },
        { key: 'safety',       fn: flushSafety },
        { key: 'position',     fn: flushPositions },
        { key: 'heartbeat',    fn: flushHeartbeats },
    ];

    for (const { key, fn } of tasks) {
        const rows = buffers[key].splice(0);
        if (!rows.length) continue;
        try {
            await fn(rows);
        } catch (err) {
            console.error(`[flush][${key}] ERROR:`, err.message);
            // вернуть обратно при ошибке — не делаем, чтобы не накапливать,
            // gextrader сделает replay через outbox
        }
    }
}

setInterval(flushAll, FLUSH_INTERVAL);

// ─── парсинг и роутинг события ────────────────────────────────────────────────
function handleMessage(raw) {
    let msg;
    try {
        msg = JSON.parse(raw);
    } catch {
        console.warn('[ws] invalid JSON, skip. Raw:', raw.substring(0, 200));
        return null;
    }

    if (msg.v !== 1) {
        console.warn(`[ws] unknown protocol version v=${msg.v}, skip`);
        return null;
    }

    const { seq, event, ts_utc } = msg;
    const tsStr = msToDateTime64(ts_utc);

    switch (event) {

        case 'tick':
            buffers.tick.push({
                seq: Number(seq),
                ts_utc:     tsStr,
                data_ts:    msToDateTime64(msg.data_ts),
                instrument: msg.instrument,
                price:      msg.price,
                volume:     msg.volume,
                at_ask:     msg.at_ask ? 1 : 0,
            });
            break;

        case 'bar':
            buffers.bar.push({
                seq: Number(seq),
                ts_utc:     tsStr,
                bar_start:  msToDateTime64(msg.bar_start),
                instrument: msg.instrument,
                open:       msg.open,
                high:       msg.high,
                low:        msg.low,
                close:      msg.close,
                volume:     msg.volume,
            });
            break;

        case 'gex_snapshot':
            buffers.gex_snapshot.push({
                seq: Number(seq),
                ts_utc:      tsStr,
                data_ts:     msToDateTime64(msg.data_ts),
                ticker:      msg.ticker,
                level:       msg.level,
                category:    msg.category,
                fields_json: JSON.stringify(msg.fields || {}),
            });
            break;

        case 'orderflow': {
            const cur  = msg.current  || {};
            const prev = msg.previous || {};
            buffers.orderflow.push({
                seq: Number(seq),
                ts_utc:             tsStr,
                cur_delta:          cur.delta          ?? 0,
                cur_total_volume:   cur.total_volume   ?? 0,
                cur_delta_percent:  cur.delta_percent  ?? 0,
                prev_delta:         prev.delta         ?? 0,
                prev_total_volume:  prev.total_volume  ?? 0,
                prev_delta_percent: prev.delta_percent ?? 0,
                footprint_json:     JSON.stringify(msg.footprint || []),
            });
            break;
        }

        case 'market':
            buffers.market.push({
                seq: Number(seq),
                ts_utc:     tsStr,
                instrument: msg.instrument,
                last:       nullable(msg.last),
                bid:        nullable(msg.bid),
                ask:        nullable(msg.ask),
                bar_close:  nullable(msg.bar_close),
            });
            break;

        case 'decision':
            buffers.decision.push({
                seq: Number(seq),
                ts_utc:             tsStr,
                entry_action:       nullable(msg.entry_action),
                exit_action:        nullable(msg.exit_action),
                matched_entry_rule: nullable(msg.matched_entry_rule),
                matched_exit_rule:  nullable(msg.matched_exit_rule),
                flatten:            msg.flatten    ? 1 : 0,
                executable:         msg.executable ? 1 : 0,
                suppressed_by:      nullable(msg.suppressed_by),
            });
            break;

        case 'safety':
            buffers.safety.push({
                seq: Number(seq),
                ts_utc:          tsStr,
                entries_allowed: msg.entries_allowed ? 1 : 0,
                should_flatten:  msg.should_flatten  ? 1 : 0,
                executable:      msg.executable      ? 1 : 0,
                cause:           msg.cause   || '',
                causes_json:     JSON.stringify(msg.causes || []),
            });
            break;

        case 'position':
            buffers.position.push({
                seq: Number(seq),
                ts_utc:       tsStr,
                instrument:   msg.instrument,
                side:         msg.side,
                quantity:     msg.quantity,
                avg_price:    msg.avg_price,
                realized_pnl: msg.realized_pnl,
            });
            break;

        case 'heartbeat':
            buffers.heartbeat.push({
                seq: Number(seq),
                ts_utc:          tsStr,
                instrument:      msg.instrument      || '',
                status:          msg.status          || '',
                ruleset_version: msg.ruleset_version || '',
                dropped:         msg.dropped         ?? 0,
            });
            break;

        default:
            console.warn(`[ws] unknown event="${event}", seq=${seq}`);
            return null;
    }

    // принудительный flush при накоплении
    for (const key of Object.keys(buffers)) {
        if (buffers[key].length >= FLUSH_MAX) {
            flushAll().catch(err => console.error('[flush] force-flush error:', err.message));
            break;
        }
    }

    return seq; // последний подтверждённый seq
}

// ─── ack-трекер на клиента ────────────────────────────────────────────────────
// Отправляем {"ack":<seq>} с наибольшим непрерывным seq по протоколу S3
function makeAckTracker(ws) {
    let maxSeq = null;

    const timer = setInterval(() => {
        if (maxSeq !== null && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ ack: maxSeq }));
            maxSeq = null;
        }
    }, ACK_INTERVAL);

    return {
        push(seq) {
            if (seq != null && (maxSeq === null || seq > maxSeq)) {
                maxSeq = seq;
            }
        },
        destroy() {
            clearInterval(timer);
        },
    };
}

// ─── WebSocket сервер ─────────────────────────────────────────────────────────
async function initDb() {
    console.log('[db] создаём таблицы если не существуют...');
    for (const ddl of DDL) {
        const tableName = (ddl.match(/CREATE TABLE IF NOT EXISTS (\S+)/) || [])[1];
        try {
            await ch.exec({ query: ddl });
            console.log(`[db] ✓ ${tableName}`);
        } catch (err) {
            console.error(`[db] ✗ ${tableName}: ${err.message}`);
            throw err;
        }
    }
    console.log('[db] все таблицы готовы');
}

async function start() {
    await initDb();

    const wss = new WebSocket.Server({ port: WS_PORT });
    console.log(`[ws] WebSocket сервер запущен на порту ${WS_PORT}`);
    console.log(`[ws] ожидаю подключения gextrader...`);

    wss.on('connection', (ws, req) => {
        const addr = req.socket.remoteAddress;
        console.log(`[ws] подключился клиент: ${addr}`);

        const ack = makeAckTracker(ws);

        ws.on('message', (data) => {
            const raw = data.toString();
            const seq = handleMessage(raw);
            if (seq != null) ack.push(seq);
        });

        ws.on('close', () => {
            console.log(`[ws] клиент отключился: ${addr}`);
            ack.destroy();
        });

        ws.on('error', (err) => {
            console.error(`[ws] ошибка клиента ${addr}:`, err.message);
        });
    });

    wss.on('error', (err) => {
        console.error('[ws] server error:', err.message);
    });

    // graceful shutdown
    process.on('SIGTERM', async () => {
        console.log('[shutdown] SIGTERM — flush и завершение...');
        await flushAll();
        process.exit(0);
    });
    process.on('SIGINT', async () => {
        console.log('[shutdown] SIGINT — flush и завершение...');
        await flushAll();
        process.exit(0);
    });
}

start().catch(err => {
    console.error('[fatal]', err);
    process.exit(1);
});