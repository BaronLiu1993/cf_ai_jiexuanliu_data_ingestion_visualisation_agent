import { Agent } from 'agents';

/* ---------------- Types ---------------- */

type Plan = {
	topic: string;
	columns: string[];
	targets: { url: string; format?: 'json' | 'rss'; name?: string }[];
};

export interface AgentEnv {
	AI: any; // Workers AI
	WORKERS_AI_MODEL?: string; // chat model
	EMBED_MODEL?: string; // embed model
	MEM?: VectorizeIndex; // Vectorize binding
}

type State = {
	lastPlan?: Plan;
	lastSchema?: { name: string; url: string; columns: string[]; sample: Record<string, any>[] };
	lastSys?: string;
};

type Table = { name: string; url: string; columns: string[]; rows: Record<string, any>[] };

// Vectorize shapes
type CFVectorPoint = { id: string; values: number[]; metadata?: Record<string, unknown> };
type CFVectorQueryResult = {
	matches: { id: string; score: number; metadata?: Record<string, unknown> }[];
};

// Chart spec
type ChartSpec = {
	title: string;
	type: 'bar' | 'line' | 'pie';
	x: string;
	y?: string;
	agg?: 'count' | 'sum' | 'mean';
	groupBy?: string;
	filter?: { field: string; op: '==' | '!='; value: string | number };
	note?: string;
};

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default class DataAgent extends Agent<AgentEnv, State> {
	initialState: State = { lastPlan: undefined, lastSchema: undefined, lastSys: undefined };

	async onRequest(req: Request) {
		const url = new URL(req.url);

		if (url.pathname === '/dataset_stream' && req.method === 'POST') {
			const body = (await req.json()) as { url?: string; text?: string; name?: string; sys?: string; embed?: boolean };
			if (!body.url && !body.text) return json({ error: 'Provide { url } or { text }' }, 400);
			return this.datasetStream(body);
		}

		if (url.pathname === '/vector_search' && req.method === 'POST') {
			const { q, k } = (await req.json()) as { q: string; k?: number };
			if (!q) return json({ error: 'Missing { q }' }, 400);
			const out = await this.vectorSearch(q, k ?? 5);
			return json(out);
		}

		if (url.pathname === '/vector_search_multi' && req.method === 'POST') {
			const { queries, k } = (await req.json()) as { queries: string[]; k?: number };
			if (!Array.isArray(queries) || queries.length === 0) return json({ error: 'Missing { queries[] }' }, 400);
			const kk = Math.max(1, Math.min(25, k ?? 5));
			const results = [];
			for (const q of queries) {
				const out = await this.vectorSearch(q, kk);
				results.push({ q, result: out });
			}
			return json({ results });
		}

		if (url.pathname === '/replan_charts' && req.method === 'POST') {
			const { sys } = (await req.json()) as { sys?: string };
			const mem = this.state.lastSchema;
			if (!mem) return json({ error: 'No dataset in memory yet.' }, 400);
			const specs = await this.planCharts(mem.columns, mem.sample, sys);
			this.setState({ ...this.state, lastSys: sys });
			return json({ specs });
		}

		if (url.pathname === '/export_csv' && req.method === 'POST') {
			const { columns, rows } = (await req.json()) as { columns: string[]; rows: Record<string, any>[] };
			if (!Array.isArray(columns) || !Array.isArray(rows)) return json({ error: 'Invalid payload' }, 400);
			const csv = this.toCSV(columns, rows);
			return new Response(csv, {
				headers: {
					'content-type': 'text/csv',
					'content-disposition': `attachment; filename="data-${Date.now()}.csv"`,
				},
			});
		}

		if (url.pathname === '/run_stream' && req.method === 'POST') {
			const { topic } = (await req.json()) as { topic: string };
			return this.runStream(topic);
		}

		if (url.pathname === '/' && req.method === 'GET') {
			return new Response(
				'POST /dataset_stream {"url":"..."} or {"text":"<json|csv>","name":"..","sys":"..","embed":true}\n' +
					'POST /vector_search {"q":"...","k":5}\n' +
					'POST /vector_search_multi {"queries":["...","..."],"k":5}\n' +
					'POST /replan_charts {"sys":"Focus on X vs Y"}\n',
				{ headers: { 'content-type': 'text/plain' } },
			);
		}

		return new Response('Not found', { status: 404 });
	}

	// --------------- DATASET STREAM ---------------
	private async datasetStream(args: { url?: string; text?: string; name?: string; sys?: string; embed?: boolean }): Promise<Response> {
		const { url: datasetUrl, text: pasted, name: providedName, sys, embed } = args;

		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const enc = (s: string) => new TextEncoder().encode(s);
		const sse = async (event: string, data: any) => {
			await writer.write(enc(`event: ${event}\n`));
			await writer.write(enc(`data: ${JSON.stringify(data)}\n\n`));
		};
		const headers = {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache',
			'x-accel-buffering': 'no',
			connection: 'keep-alive',
		} as const;

		(async () => {
			try {
				let columns: string[] = [];
				let rows: Record<string, any>[] = [];
				const name = providedName || (datasetUrl ? this.hostName(datasetUrl) : 'pasted-data');

				if (datasetUrl) {
					await sse('log', { msg: `Fetching dataset: ${datasetUrl}` });
					const resp = await fetch(datasetUrl);
					if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
					const ct = (resp.headers.get('content-type') || '').toLowerCase();

					if (this.isCSV(ct) || datasetUrl.endsWith('.csv')) {
						const text = await resp.text();
						const parsed = this.parseCSV(text);
						columns = parsed.columns;
						rows = parsed.rows;
						await sse('log', { msg: `Parsed CSV: ${rows.length} rows.` });
					} else if (this.isNDJSON(ct) || datasetUrl.endsWith('.ndjson') || datasetUrl.endsWith('.jsonl')) {
						const text = await resp.text();
						const objs = text
							.split(/\r?\n/)
							.filter(Boolean)
							.slice(0, 20000)
							.map((s) => {
								try {
									return JSON.parse(s);
								} catch {
									return {};
								}
							});
						columns = this.discoverColumnsFromObjects(objs);
						rows = objs.map((o) => this.pick(columns, o));
						await sse('log', { msg: `Parsed NDJSON: ${rows.length} rows.` });
					} else if (this.isJSON(ct) || datasetUrl.endsWith('.json')) {
						const body = await resp.json();
						({ columns, rows } = this.parseArbitraryJSON(body));
						await sse('log', { msg: `Parsed JSON: ${rows.length} rows.` });
					} else if (this.isXML(ct) || datasetUrl.endsWith('.xml') || datasetUrl.endsWith('.rss')) {
						const xml = await resp.text();
						const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 2000);
						columns = ['title', 'url', 'time'];
						rows = items.map((m) => {
							const b = m[1];
							return { title: this.tag(b, 'title'), url: this.tag(b, 'link'), time: this.tag(b, 'pubDate') };
						});
						await sse('log', { msg: `Parsed RSS/XML: ${rows.length} items.` });
					} else {
						const html = await resp.text();
						columns = ['title', 'url'];
						rows = this.parseHTMLToRows(html, columns).slice(0, 5000);
						await sse('log', { msg: `Parsed HTML: ${rows.length} rows.` });
					}
				} else if (pasted) {
					await sse('log', { msg: 'Parsing pasted data…' });
					const guess = pasted.trim();
					if (guess.startsWith('{') || guess.startsWith('[')) {
						let body: unknown;
						try {
							body = JSON.parse(guess);
						} catch {
							throw new Error('Invalid JSON in pasted text.');
						}
						({ columns, rows } = this.parseArbitraryJSON(body));
						await sse('log', { msg: `Parsed JSON: ${rows.length} rows.` });
					} else if (guess.includes(',') || guess.includes('\n')) {
						const parsed = this.parseCSV(guess);
						columns = parsed.columns;
						rows = parsed.rows;
						await sse('log', { msg: `Parsed CSV-ish text: ${rows.length} rows.` });
					} else {
						columns = ['value'];
						rows = [{ value: guess }];
						await sse('log', { msg: `Parsed plain text.` });
					}
				}

				// Clean / normalize
				const before = rows.length;
				const cleaned = this.cleanRows(columns, rows);
				columns = cleaned.columns;
				rows = cleaned.rows;
				await sse('log', { msg: `Cleaned data: ${before} → ${rows.length} rows, ${columns.length} cols.` });

				// Remember last dataset (for /replan_charts)
				this.setState({
					...this.state,
					lastSchema: { name, url: datasetUrl ?? '(pasted)', columns, sample: rows.slice(0, 2000) },
					lastSys: sys,
				});

				// Schema first (UI shows Search & Charts above the table)
				await sse('schema', { name, url: datasetUrl ?? '(pasted)', columns, count: rows.length });

				// Embeddings
				const doEmbed = embed === true;
				if (!this.env.MEM) {
					await sse('warn', { msg: 'Vectorize MEM binding missing; skipping embeddings.' });
				} else if (doEmbed) {
					await sse('log', { msg: 'Ranking rows for embedding…' });
					const chosen = await this.rankRowsForEmbedding(columns, rows, this.env.WORKERS_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct');
					await sse('log', { msg: `Vectorizing ${chosen.length} rows…` });
					const embedded = await this.embedRows(
						name,
						datasetUrl ?? '(pasted)',
						columns,
						chosen,
						this.env.EMBED_MODEL || '@cf/baai/bge-base-en-v1.5',
					);
					await sse('vectorized', { count: embedded });
				}

				// Charts & insights (honor sys)
				await sse('log', { msg: 'Planning charts & insights…' });
				const specs = await this.planCharts(columns, rows.slice(0, 2000), sys);
				await sse('insights', { specs, data: rows.slice(0, 2000) });


				// Table LAST (so it shows under charts/search)
				await sse('table', { table: { name, url: datasetUrl ?? '(pasted)', columns, rows: rows.slice(0, 500) } });

				await sse('log', { msg: 'Done.' });
			} catch (e: any) {
				await sse('error', { msg: String(e?.message || e) });
			} finally {
				await writer.close();
			}
		})();

		return new Response(readable, { headers });
	}

	// --------------- VECTOR SEARCH ---------------
	private async vectorSearch(
    q: string,
    k: number
  ): Promise<CFVectorQueryResult | { warn: string; debug?: string }> {
    if (!this.env.MEM) return { warn: "Vectorize MEM binding not configured." };
    
    if (!q || typeof q !== 'string' || !q.trim()) {
      return { warn: "Query is empty or invalid" };
    }
  
    const model = this.env.EMBED_MODEL || "@cf/baai/bge-base-en-v1.5";
    console.log(`Vector search for: "${q}" using model: ${model}`);
    
    const { vec, debug } = await this.embedTextRobust(q, model, true);
    
    if (!vec || !Array.isArray(vec) || vec.length === 0) {
      console.error("Embedding failed:", debug);
      return { warn: "Could not embed query.", debug };
    }
    
    if (vec.length !== 768) {
      return { warn: `Wrong vector dimensions: expected 768, got ${vec.length}`, debug };
    }
    
    // Force proper serialization by creating a completely new array
    const cleanVector: number[] = [];
    for (let i = 0; i < vec.length; i++) {
      const num = Number(vec[i]);
      cleanVector.push(isFinite(num) ? num : 0.0);
    }
  
    try {
      const options = {
        topK: Math.max(1, Math.min(25, k))
      };
      
      console.log(`Calling Vectorize with topK: ${options.topK}`);
      
      // Correctly pass the vector first, then the options object.
      const result = await this.env.MEM.query(cleanVector, options);
      
      console.log(`Vector search returned ${result.matches?.length || 0} matches`);
      return result;
      
    } catch (e: any) {
      console.error("Vectorize query failed:", e);
      return { warn: "Vector search failed", debug: String(e?.message || e) };
    }
  }
	private async embedTextRobust(text: string, embedModel: string, wantDebug = false): Promise<{ vec: number[] | null; debug?: string }> {
		// Validate input
		if (!text || typeof text !== 'string') {
			return { vec: null, debug: 'Invalid or empty text input' };
		}

		const cleanText = text.trim().slice(0, 512);

		if (!cleanText) {
			return { vec: null, debug: 'Text is empty after cleaning' };
		}

		const parseVector = (out: any): number[] | null => {
			if (wantDebug) {
				console.log('Raw AI output:', JSON.stringify(out, null, 2));
			}

			if (!out) return null;

			// BGE model returns: { data: [[...768 numbers]], shape: [1, 768] }
			if (out.data && Array.isArray(out.data) && out.data.length > 0) {
				const firstItem = out.data[0];
				if (Array.isArray(firstItem) && firstItem.length > 0 && typeof firstItem[0] === 'number') {
					console.log(`✅ Found embedding in data[0]: ${firstItem.length} dimensions`);
					return firstItem.map(Number);
				}
			}

			// Alternative structures
			if (Array.isArray(out.embedding) && out.embedding.length > 0) {
				console.log(`✅ Found embedding in root: ${out.embedding.length} dimensions`);
				return out.embedding.map(Number);
			}

			// Direct array response
			if (Array.isArray(out) && typeof out[0] === 'number' && out.length > 0) {
				console.log(`✅ Found direct array: ${out.length} dimensions`);
				return out.map(Number);
			}

			console.log('❌ No valid embedding vector found in output');
			return null;
		};

		// For BGE models, the standard format works
		try {
			console.log(`🔄 Embedding text with BGE model: ${embedModel}`);
			const out = await this.env.AI.run(embedModel, { text: cleanText });

			const vec = parseVector(out);
			if (vec && vec.length > 0) {
				console.log(`✅ Success: Got ${vec.length} dimensions`);

				// Validate it's the expected 768 dimensions for BGE-base
				if (vec.length !== 768) {
					console.warn(`⚠️  Expected 768 dimensions, got ${vec.length}`);
				}

				return { vec, debug: `BGE embedding → ok (${vec.length} dims)` };
			}

			const errMsg = 'BGE model returned data but no valid vector found';
			console.log(`❌ ${errMsg}`);
			return { vec: null, debug: errMsg };
		} catch (e: any) {
			const errMsg = `BGE embedding failed: ${String(e?.message || e)}`;
			console.log(`❌ ${errMsg}`);
			return { vec: null, debug: errMsg };
		}
	}

	// --------------- Topic Mode (optional) ---------------
	private async runStream(topic: string): Promise<Response> {
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const enc = (s: string) => new TextEncoder().encode(s);
		const sse = async (event: string, data: any) => {
			await writer.write(enc(`event: ${event}\n`));
			await writer.write(enc(`data: ${JSON.stringify(data)}\n\n`));
		};
		const headers = {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache',
			'x-accel-buffering': 'no',
			connection: 'keep-alive',
		};

		(async () => {
			try {
				await sse('log', { msg: `Planning for "${topic}"…` });
				const plan = await this.planWithWorkersAI(topic);
				await sse('plan', { plan });
				for (const t of plan.targets.slice(0, 5)) {
					await sse('log', { msg: `Scraping ${t.name ?? this.hostName(t.url)}…` });
					const table = await this.scrapeOne(t, plan.columns);
					await sse('table', { table });
				}
				await sse('log', { msg: 'Done.' });
			} catch (e: any) {
				await sse('error', { msg: String(e?.message || e) });
			} finally {
				await writer.close();
			}
		})();

		return new Response(readable, { headers });
	}

	// --------------- PLAN (topic mode) ---------------
	private async planWithWorkersAI(topic: string): Promise<Plan> {
		const model = this.env.WORKERS_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct';
		const res = await this.env.AI.run(model, {
			messages: [
				{ role: 'system', content: 'Return ONLY valid JSON for `columns` and `targets`. No prose.' },
				{
					role: 'user',
					content: `For "${topic}", propose up to 3 public JSON or RSS endpoints (no auth).
Respond exactly:
{"columns":["title","url","score","by","time"],
 "targets":[{"url":"...", "format":"json"|"rss","name":"short-source-name-optional"}]}`,
				},
			],
			temperature: 0.2,
		});

		const text = String(res?.response ?? res?.output_text ?? '{}');
		let plan: Plan = { topic, columns: ['title', 'url'], targets: [] };
		try {
			const parsed = JSON.parse(text) as Partial<Plan>;
			if (Array.isArray(parsed.columns) && parsed.columns.length) plan.columns = parsed.columns;
			if (Array.isArray(parsed.targets) && parsed.targets.length) plan.targets = parsed.targets as Plan['targets'];
		} catch {}
		if (!plan.targets.length) {
			plan.targets = [{ url: 'https://hacker-news.firebaseio.com/v0/topstories.json', format: 'json', name: 'hacker-news' }];
			plan.columns = ['title', 'url', 'score', 'by', 'time'];
		}
		for (const t of plan.targets) if (!t.name) t.name = this.hostName(t.url);
		return plan;
	}

	// --------------- CHART PLANNING ---------------
	private async planCharts(columns: string[], rowsSample: Record<string, any>[], sys?: string): Promise<ChartSpec[]> {
		const model = this.env.WORKERS_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct';
		const preview = rowsSample.slice(0, 80);
		const sysMsg = sys?.trim()
			? `${sys}\n\nYou must output ONLY a JSON array of chart specs.`
			: `You're a data viz assistant. Propose 1-3 concise chart specs (JSON only) to summarize the data.
Allowed types: "bar","line","pie". Use fields from 'columns'. If numeric aggregation is useful, set "agg" to "count","sum", or "mean".
Optionally provide "groupBy" and a short "note" insight. Return ONLY a JSON array.`;

		const messages = [
			{ role: 'system', content: sysMsg },
			{ role: 'user', content: JSON.stringify({ columns, sample: preview }, null, 2) },
		];
		const out = await this.env.AI.run(model, { messages, temperature: 0.2 });
		const txt = String(out?.response ?? out?.output_text ?? '[]');

		try {
			const arr = JSON.parse(txt);
			if (Array.isArray(arr)) return arr.filter((s) => s && s.type && s.x).slice(0, 3) as ChartSpec[];
		} catch {}

		// fallback
		const numerics = this.numericColumns(columns, rowsSample);
		if (numerics.length) {
			return [{ title: `Mean ${numerics[0]} by ${columns[0]}`, type: 'bar', x: columns[0], y: numerics[0], agg: 'mean' }];
		}
		return [{ title: `Count by ${columns[0]}`, type: 'bar', x: columns[0], agg: 'count' }];
	}

	private numericColumns(columns: string[], rows: Record<string, any>[]) {
		const nums: string[] = [];
		for (const c of columns) {
			let ok = 0,
				total = 0;
			for (const r of rows.slice(0, 200)) {
				const v = r[c];
				if (v === '' || v == null) continue;
				total++;
				if (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v))) ok++;
			}
			if (total >= 5 && ok / total > 0.7) nums.push(c);
		}
		return nums;
	}

	// --------------- IMPORTANCE RANKING FOR EMBEDDING ---------------
	private async rankRowsForEmbedding(columns: string[], rows: Record<string, any>[], model: string) {
		const sample = rows.slice(0, Math.min(rows.length, 1200));
		const compact = sample.map((r, i) => ({ i, t: columns.map((c) => `${c}:${r[c] ?? ''}`).join('; ') }));

		const messages = [
			{
				role: 'system',
				content: `Given a list of rows (index + short text), choose up to 200 indices that are DIVERSE and informative for future semantic search.
Return ONLY a JSON array of indices (numbers).`,
			},
			{ role: 'user', content: JSON.stringify(compact, null, 0) },
		];
		let chosenIdx: number[] = [];
		try {
			const out = await this.env.AI.run(model, { messages, temperature: 0 });
			const txt = String(out?.response ?? out?.output_text ?? '[]');
			const arr = JSON.parse(txt);
			if (Array.isArray(arr)) chosenIdx = arr.filter((n) => Number.isInteger(n)).slice(0, 200);
		} catch {
			/* fall back below */
		}
		if (!chosenIdx.length) chosenIdx = compact.map((x) => x.i).slice(0, Math.min(200, compact.length));
		return chosenIdx.map((i) => rows[i]);
	}

	private async embedRows(datasetName: string, sourceUrl: string, columns: string[], rows: Record<string, any>[], embedModel: string) {
		if (!this.env.MEM) return 0;

		let count = 0;
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			const text = columns.map((c) => `${c}: ${row[c] ?? ''}`).join(' | ');
			const { vec } = await this.embedTextRobust(text, embedModel);

			// Add the same validation as vectorSearch
			if (!vec || !Array.isArray(vec) || vec.length !== 768) {
				console.warn(`Skipping row ${i}: invalid vector (length: ${vec?.length || 0})`);
				continue;
			}

			// Clean the vector like in vectorSearch
			const cleanVector = vec.map((v) => {
				const num = Number(v);
				return isFinite(num) ? num : 0;
			});

			const id = `ds:${this.hash(`${datasetName}:${i}:${text.slice(0, 128)}`)}`;
			await (this.env.MEM as any).upsert([
        { id, values: cleanVector, metadata: { dataset: datasetName, url: sourceUrl, rowIndex: i, row: row } },
      ]);
			count++;
		}
		return count;
	}

	// --------------- SCRAPER (topic mode) ---------------
	private async scrapeOne(t: Plan['targets'][number], columns: string[]): Promise<Table> {
		let rows: Record<string, any>[] = [];
		try {
			const resp = await fetch(t.url);
			const ct = resp.headers.get('content-type') || '';

			if (t.format === 'rss' || this.isXML(ct)) {
				const xml = await resp.text();
				const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 50);
				rows = items.map((m) => {
					const block = m[1];
					return { title: this.tag(block, 'title'), url: this.tag(block, 'link'), score: '', by: '', time: this.tag(block, 'pubDate') };
				});
			} else if (this.isJSON(ct)) {
				const body = await resp.json();
				if (Array.isArray(body)) rows = body.slice(0, 200).map((it: any) => this.pick(columns, it));
				else if (body && typeof body === 'object') {
					const obj = body as Record<string, unknown>;
					const listKey = Object.keys(obj).find((k) => Array.isArray((obj as any)[k]));
					const arr = listKey ? ((obj as any)[listKey] as any[]) : [];
					rows = (Array.isArray(arr) ? arr.slice(0, 200) : []).map((it: any) => this.pick(columns, it));
				}
			} else {
				const html = await resp.text();
				rows = this.parseHTMLToRows(html, columns);
			}
		} catch (e) {
			rows = [{ error: String(e) }];
		}
		return { name: t.name || this.hostName(t.url), url: t.url, columns, rows };
	}

	// --------------- CLEANING / PARSING ---------------
	private parseArbitraryJSON(body: unknown): { columns: string[]; rows: Record<string, any>[] } {
		if (Array.isArray(body)) {
			const columns = this.discoverColumnsFromObjects(body);
			const rows = (body as any[]).slice(0, 20000).map((o) => this.pick(columns, o));
			return { columns, rows };
		}
		if (body && typeof body === 'object') {
			const obj = body as Record<string, any>;
			// top-level array field?
			const arrKey = Object.keys(obj).find((k) => Array.isArray(obj[k]));
			if (arrKey) {
				const arr = obj[arrKey] as any[];
				const columns = this.discoverColumnsFromObjects(arr);
				const rows = arr.slice(0, 20000).map((o) => this.pick(columns, o));
				return { columns, rows };
			}
			// object-of-objects (e.g., { data: { Aatrox: {...}, ... } })
			const objKey = Object.keys(obj).find((k) => obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k]));
			if (objKey) {
				const vals = Object.values(obj[objKey]);
				if (Array.isArray(vals)) {
					const columns = this.discoverColumnsFromObjects(vals);
					const rows = vals.slice(0, 20000).map((o) => this.pick(columns, o as any));
					return { columns, rows };
				}
			}
			const columns = Object.keys(obj);
			const rows = [obj];
			return { columns, rows };
		}
		return { columns: ['value'], rows: [{ value: String(body) }] };
	}

	private cleanRows(columns: string[], rows: Record<string, any>[]) {
		const seen = new Set<string>();
		const out: Record<string, any>[] = [];
		let cols = [...columns];

		const toNum = (v: any) => {
			if (typeof v === 'number') return v;
			const s = String(v);
			if (!/^[-\d.,]+$/.test(s)) return v;
			const n = parseFloat(s.replace(/,/g, ''));
			return Number.isNaN(n) ? v : n;
		};

		for (const r of rows) {
			const rr: Record<string, any> = {};
			for (const c of cols) {
				const v = r[c];
				rr[c] = typeof v === 'string' ? v.trim() : v;
				rr[c] = toNum(rr[c]);
			}
			const isEmpty = cols.every((c) => rr[c] === '' || rr[c] == null);
			if (isEmpty) continue;
			const key = JSON.stringify(rr);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(rr);
		}

		const keep = cols.filter((c) => out.some((r) => r[c] !== '' && r[c] != null));
		if (keep.length && keep.length !== cols.length) {
			cols = keep;
			for (const r of out) for (const k of Object.keys(r)) if (!keep.includes(k)) delete r[k];
		}

		return { columns: cols, rows: out };
	}

	private isCSV(ct: string) {
		return /text\/csv|application\/csv/i.test(ct);
	}
	private isNDJSON(ct: string) {
		return /ndjson|jsonl/i.test(ct);
	}
	private isXML(ct: string) {
		return /xml|rss|atom/i.test(ct);
	}
	private isJSON(ct: string) {
		return /json/i.test(ct);
	}
	private isHTML(ct: string) {
		return /text\/html|text\/plain/i.test(ct);
	}

	private parseHTMLToRows(html: string, columns: string[]) {
		const rows: Record<string, any>[] = [];
		const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
		if (t) rows.push(this.pick(columns, { title: t, url: '' }));
		const anchors = [...html.matchAll(/<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].slice(0, 200);
		for (const a of anchors) {
			const href = a[1];
			const text = (a[2] || '').replace(/<[^>]+>/g, '').trim();
			rows.push(this.pick(columns, { title: text || href, url: href }));
		}
		return rows;
	}

	private discoverColumnsFromObjects(objs: any[]): string[] {
		const set = new Set<string>();
		for (const o of objs.slice(0, 400)) {
			if (o && typeof o === 'object' && !Array.isArray(o)) {
				for (const k of Object.keys(o)) set.add(k);
			}
		}
		const cols = [...set];
		return cols.length ? cols : ['value'];
	}

	private parseCSV(text: string): { columns: string[]; rows: Record<string, any>[] } {
		const lines = text
			.replace(/\r/g, '')
			.split('\n')
			.filter((l) => l.length > 0);
		if (!lines.length) return { columns: [], rows: [] };

		const parseLine = (line: string) => {
			const out: string[] = [];
			let cur = '';
			let inQ = false;
			for (let i = 0; i < line.length; i++) {
				const ch = line[i];
				if (inQ) {
					if (ch === '"' && line[i + 1] === '"') {
						cur += '"';
						i++;
					} else if (ch === '"') inQ = false;
					else cur += ch;
				} else {
					if (ch === ',') {
						out.push(cur);
						cur = '';
					} else if (ch === '"') inQ = true;
					else cur += ch;
				}
			}
			out.push(cur);
			return out;
		};

		const header = parseLine(lines[0]).map((h) => h.trim());
		const rows: Record<string, any>[] = [];
		for (const ln of lines.slice(1, 20001)) {
			const vals = parseLine(ln);
			const obj: Record<string, any> = {};
			for (let i = 0; i < header.length; i++) obj[header[i] || `col${i}`] = vals[i] ?? '';
			rows.push(obj);
		}
		return { columns: header, rows };
	}

	private toCSV(columns: string[], rows: Record<string, any>[]) {
		const header = columns.join(',');
		const body = rows.map((r) => columns.map((c) => this.csvCell(r[c])).join(',')).join('\n');
		return header + '\n' + body;
	}
	private csvCell(v: unknown) {
		if (v == null) return '';
		const s = String(v).replace(/"/g, '""');
		return /[",\n]/.test(s) ? `"${s}"` : s;
	}
	private pick(cols: string[], obj: any) {
		const out: Record<string, any> = {};
		for (const c of cols) out[c] = obj?.[c] ?? '';
		return out;
	}
	private tag(xml: string, name: string) {
		const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
		return m ? m[1].trim() : '';
	}
	private hostName(u: string) {
		try {
			return new URL(u).hostname.replace(/^www\./, '');
		} catch {
			return 'source';
		}
	}
	private hash(s: string) {
		let h = 2166136261 >>> 0;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return (h >>> 0).toString(36);
	}
}

export { DataAgent };
