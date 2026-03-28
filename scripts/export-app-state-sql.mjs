import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const storePath = path.join(__dirname, "..", "data", "store.json");

const raw = await readFile(storePath, "utf8");
const parsed = JSON.parse(raw);
const payload = JSON.stringify(parsed).replace(/'/g, "''");

const sql = `insert into public.app_state (id, payload)
values ('main', '${payload}'::jsonb)
on conflict (id)
do update set payload = excluded.payload;`;

process.stdout.write(sql);
