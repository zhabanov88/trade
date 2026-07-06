const { Pool } = require("pg");
const pool = new Pool({ host: "greenplum-db", port: 5432, database: "postgres", user: "gpadmin", password: "GreenPlum" });
const code = "return TVEngine.define({ name: \"CISD\", id: \"cisd@tv-basicstudies-1\", overlay: true, inputs: [], defaultInputs: {}, buildCfg: function(inp) { return {}; }, analyze: function(bars, cfg) { return []; } });";
pool.query("UPDATE javascript_scripts SET code =  WHERE id = 65", [code]).then(() => { console.log("ok"); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); });
