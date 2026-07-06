/**
 * gexbot-ingest.js  v2.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Gexbot REST → ClickHouse raw_market_data
 *
 * Polls all accessible endpoints every POLL_INTERVAL_MS and inserts snapshots.
 *
 * Env vars:
 *   GEXBOT_API_KEY      – gexbot_custom_... key
 *   CLICKHOUSE_HOST     – default: localhost
 *   CLICKHOUSE_PORT     – default: 8123
 *   CLICKHOUSE_DB       – default: default
 *   CLICKHOUSE_USER     – default: default
 *   CLICKHOUSE_PASSWORD – default: (empty)
 *   POLL_INTERVAL_MS    – default: 15000  (15 sec)
 *   TICKERS             – comma-separated, default: all
 *
 * provider_id in raw_market_data:
 *   100 = Gexbot classic GEX
 *   101 = Gexbot state Greeks
 *   102 = Gexbot orderflow
 *
 * ticker field format:
 *   {TICKER}_classic_{category}   e.g. SPX_classic_gex_full
 *   {TICKER}_state_{category}     e.g. SPX_state_gamma
 *   {TICKER}_orderflow            e.g. SPX_orderflow
 *
 * Install:
 *   npm install node-fetch
 *
 * Run:
 *   node gexbot-ingest.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const http = require('http');

// ─── Config ──────────────────────────────────────────────────────────────────

const API_KEY          = process.env.GEXBOT_API_KEY || '';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '15000');
const CH_HOST          = process.env.CLICKHOUSE_HOST     || 'localhost';
const CH_PORT          = parseInt(process.env.CLICKHOUSE_PORT || '8123');
const CH_DB            = process.env.CLICKHOUSE_DB       || 'default';
const CH_USER          = process.env.CLICKHOUSE_USER     || 'default';
const CH_PASS          = process.env.CLICKHOUSE_PASSWORD || '';

const ALL_TICKERS = [
  // Indexes
  'SPX','NDX','RUT','VIX',
  // Variants
  'SPXW','NDXP','RUTW','VIXW','ES_SPX','NQ_NDX',
  // ETFs
  'SPY','QQQ','IWM','DIA','TLT','HYG','GLD','SLV','USO','UNG','TQQQ','UVXY',
  // Stocks
  'AAPL','MSFT','NVDA','TSLA','META','AMZN','GOOG','GOOGL',
  'AMD','AVGO','INTC','MU','SMCI',
  'PLTR','CRWD','DDOG','SNOW','RDDT','APP',
  'COIN','HOOD','MSTR','IBIT','IONQ',
  'NFLX','UBER','SHOP','ORCL','BOIL',
  'GME','SOFI','ROKU','VALE','NVO','TSM','BABA',
];

const TICKERS = process.env.TICKERS
  ? process.env.TICKERS.split(',').map(t => t.trim()).filter(Boolean)
  : ALL_TICKERS;

// Categories to try — 403 = not subscribed, will be auto-skipped
const CLASSIC_CATS   = ['gex_full', 'gex_zero', 'gex_one'];
const STATE_CATS     = ['gamma','delta','vanna','charm',
                        'gamma_zero','delta_zero','vanna_zero','charm_zero'];
const ORDERFLOW_CAT  = 'orderflow';

if (!API_KEY) {
  console.error('[gexbot] GEXBOT_API_KEY not set. Exiting.');
  process.exit(1);
}

// ─── Track which endpoints 403'd so we stop hammering them ───────────────────

const blocked = new Set();  // stores endpoint path strings

// ─── ClickHouse insert ───────────────────────────────────────────────────────

/**
 * Format Date → 'YYYY-MM-DD HH:MM:SS.nnnnnnnnn' for DateTime64(9)
 */
function fmtTs(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n, w) => String(n).padStart(w, '0');
  const ms = d.getUTCMilliseconds();
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1,2)}-${p(d.getUTCDate(),2)} ` +
         `${p(d.getUTCHours(),2)}:${p(d.getUTCMinutes(),2)}:${p(d.getUTCSeconds(),2)}.` +
         `${p(ms * 1_000_000, 9)}`;
}

/**
 * Insert array of row objects into raw_market_data via ClickHouse HTTP.
 * Each row: { ticker, ts, provider_id, price, extra }
 */
function chInsert(rows) {
  if (!rows.length) return Promise.resolve();

  const lines = rows.map(r => JSON.stringify({
    ticker:                r.ticker,
    participant_timestamp: fmtTs(r.ts),
    provider_id:           r.provider_id,
    price:                 String(r.price ?? '0'),
    size:                  '0',
    extra:                 JSON.stringify(r.extra ?? {}),
    tick_index:            0,
  })).join('\n');

  const query = `INSERT INTO ${CH_DB}.raw_market_data FORMAT JSONEachRow`;
  const params = new URLSearchParams({ query, user: CH_USER });
  if (CH_PASS) params.set('password', CH_PASS);

  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: CH_HOST, port: CH_PORT, path: `/?${params}`, method: 'POST' },
      (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          if (res.statusCode !== 200)
            reject(new Error(`CH ${res.statusCode}: ${body.trim()}`));
          else resolve();
        });
      }
    );
    req.on('error', reject);
    req.write(lines);
    req.end();
  });
}

// ─── Gexbot REST fetch ───────────────────────────────────────────────────────

const BASE = 'https://api.gex.bot/v2';
const HEADERS = {
  'Authorization': `Bearer ${API_KEY}`,
  'Accept':        'application/json',
  'Content-Type':  'application/json',
  'User-Agent':    'gexbot-ingest/2.0',
};

async function gexFetch(path) {
  // Node 18+ has global fetch; older versions need node-fetch
  const fetchFn = globalThis.fetch ?? require('node-fetch');
  const res = await fetchFn(`${BASE}${path}`, { headers: HEADERS });

  if (res.status === 403) {
    blocked.add(path);
    return null;  // not subscribed — skip silently
  }
  if (res.status === 429) {
    console.warn(`[gexbot] Rate limited on ${path}, backing off`);
    await new Promise(r => setTimeout(r, 5000));
    return null;
  }
  if (!res.ok) {
    throw new Error(`${res.status} on ${path}`);
  }
  return res.json();
}

// ─── Convert API response → raw_market_data row ──────────────────────────────

function toRow(ticker, providerId, data) {
  if (!data) return null;

  // Use API timestamp if present, else now
  const ts = data.timestamp ? new Date(data.timestamp * 1000) : new Date();

  // Store full snapshot in extra — strikes compressed to [strike, gex_vol, gex_oi]
  const extra = { ...data };
  if (Array.isArray(data.strikes)) {
    extra.strikes = data.strikes.map(s => [s[0], s[1], s[2]]);  // drop prior history
  }

  return {
    ticker,
    ts,
    provider_id: providerId,
    price:       data.spot ?? 0,
    extra,
  };
}

// ─── Poll one ticker across all packages ─────────────────────────────────────

async function pollTicker(ticker) {
  const rows = [];

  // Classic GEX
  for (const cat of CLASSIC_CATS) {
    const path = `/${ticker}/classic/${cat}`;
    if (blocked.has(path)) continue;
    try {
      const data = await gexFetch(path);
      const row = toRow(`${ticker}_classic_${cat}`, 100, data);
      if (row) rows.push(row);
    } catch (e) {
      console.warn(`[gexbot] ${path}: ${e.message}`);
    }
  }

  // State Greeks
  for (const cat of STATE_CATS) {
    const path = `/${ticker}/state/${cat}`;
    if (blocked.has(path)) continue;
    try {
      const data = await gexFetch(path);
      const row = toRow(`${ticker}_state_${cat}`, 101, data);
      if (row) rows.push(row);
    } catch (e) {
      console.warn(`[gexbot] ${path}: ${e.message}`);
    }
  }

  // Orderflow
  const ofPath = `/${ticker}/orderflow/${ORDERFLOW_CAT}`;
  if (!blocked.has(ofPath)) {
    try {
      const data = await gexFetch(ofPath);
      const row = toRow(`${ticker}_orderflow`, 102, data);
      if (row) rows.push(row);
    } catch (e) {
      console.warn(`[gexbot] ${ofPath}: ${e.message}`);
    }
  }

  return rows;
}

// ─── Main poll loop ───────────────────────────────────────────────────────────

async function runOnce() {
  const started = Date.now();
  let total = 0;

  // Poll tickers sequentially to avoid rate limiting
  for (const ticker of TICKERS) {
    const rows = await pollTicker(ticker).catch(e => {
      console.error(`[gexbot] ${ticker} failed: ${e.message}`);
      return [];
    });

    if (rows.length) {
      await chInsert(rows).catch(e => console.error(`[ch] insert error: ${e.message}`));
      total += rows.length;
    }
  }

  const elapsed = Date.now() - started;
  console.log(`[gexbot] cycle done: ${total} rows in ${elapsed}ms (blocked: ${blocked.size} endpoints)`);
}

async function main() {
  console.log(`[gexbot] Starting. Tickers: ${TICKERS.length}, interval: ${POLL_INTERVAL_MS}ms`);
  console.log(`[gexbot] ClickHouse: ${CH_HOST}:${CH_PORT}/${CH_DB}`);

  // First poll immediately
  await runOnce();

  // Then on interval
  setInterval(async () => {
    try { await runOnce(); }
    catch (e) { console.error('[gexbot] Unhandled error in cycle:', e.message); }
  }, POLL_INTERVAL_MS);
}

main();