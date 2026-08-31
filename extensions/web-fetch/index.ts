import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Cloudflare from "cloudflare";

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_WAIT_UNTIL = "networkidle2";
const DEFAULT_FORMAT = "markdown";
const DEFAULT_CACHE_TTL_SECONDS = 3600;
const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const AUTH_PATH = path.join(EXT_DIR, "auth.json");
const CACHE_DIR = path.join(EXT_DIR, ".cache");

type Format = "markdown" | "html" | "text" | "links" | "screenshot" | "pdf" | "snapshot" | "json";
type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";

interface Credentials { accountId: string; apiToken: string }
interface Viewport { width: number; height: number; deviceScaleFactor?: number; isMobile?: boolean; hasTouch?: boolean; isLandscape?: boolean }
interface CacheOptions { enabled?: boolean; ttlSeconds?: number }
interface ExtractOptions { selector?: string; includeLinks?: boolean; includeImages?: boolean }
interface CleanOptions { removeSelectors?: string[]; rejectRequestPattern?: string[] }
interface StructuredOptions { prompt?: string; schema?: Record<string, unknown> }
interface Action { type: "click" | "type" | "waitForSelector" | "wait"; selector?: string; text?: string; ms?: number }

interface FetchArgs {
	url: string;
	format?: Format;
	waitUntil?: WaitUntil;
	waitForSelector?: string;
	timeoutMs?: number;
	userAgent?: string;
	rejectRequestPattern?: string[];
	viewport?: Viewport;
	headers?: Record<string, string>;
	cache?: CacheOptions;
	fresh?: boolean;
	extract?: ExtractOptions;
	clean?: CleanOptions;
	metadata?: boolean;
	structured?: StructuredOptions;
	actions?: Action[];
}

interface FetchResult {
	url: string;
	title: string;
	content: string;
	format: Format;
	source: "cloudflare-browser-run";
	cached: boolean;
	renderMs: number;
}

function loadCredentials(): Credentials | null {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID;
	const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? process.env.CLOUDFLARE_BROWSER_RENDERING_API_TOKEN;
	if (accountId && apiToken) return { accountId, apiToken };
	if (!fs.existsSync(AUTH_PATH)) return null;
	try {
		const c = JSON.parse(fs.readFileSync(AUTH_PATH, "utf-8"));
		const fileAccountId = c.cloudflare_account_id ?? c.account_id;
		const fileApiToken = c.cloudflare_api_token ?? c.api_token;
		if (fileAccountId && fileApiToken) return { accountId: fileAccountId, apiToken: fileApiToken };
	} catch {}
	return null;
}

function credentialHelp(): string {
	return [
		"Missing Cloudflare Browser Run credentials.",
		"Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or create:",
		`  ${AUTH_PATH}`,
		"The token needs the 'Browser Rendering - Edit' permission.",
	].join("\n");
}

function normalizeUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http:// and https:// URLs are supported.");
	return url.toString();
}

function extractHeadingTitle(markdown: string): string | null {
	const match = markdown.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	return match[1].replace(/\[[^\]]+\]\([^\)]+\)/g, (link) => link.match(/^\[([^\]]+)\]/)?.[1] ?? link).replace(/[*_`#]+/g, "").trim() || null;
}

function titleFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const last = parsed.pathname.split("/").filter(Boolean).pop();
		return last ? decodeURIComponent(last).replace(/[-_]+/g, " ") : parsed.hostname;
	} catch { return url; }
}

function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|h[1-6]|li)>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

function stableJson(value: unknown): string {
	if (!value || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

function cacheKey(args: FetchArgs): string {
	const { cache: _cache, fresh: _fresh, ...rest } = args;
	return crypto.createHash("sha256").update(stableJson(rest)).digest("hex");
}

function readCache(args: FetchArgs): FetchResult | null {
	if (args.fresh || args.cache?.enabled === false) return null;
	const ttl = args.cache?.ttlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
	const file = path.join(CACHE_DIR, `${cacheKey(args)}.json`);
	if (!fs.existsSync(file)) return null;
	try {
		const entry = JSON.parse(fs.readFileSync(file, "utf-8")) as { savedAt: number; result: FetchResult };
		if (Date.now() - entry.savedAt > ttl * 1000) return null;
		return { ...entry.result, cached: true };
	} catch { return null; }
}

function writeCache(args: FetchArgs, result: FetchResult) {
	if (args.cache?.enabled === false || result.format === "screenshot" || result.format === "pdf") return;
	fs.mkdirSync(CACHE_DIR, { recursive: true });
	fs.writeFileSync(path.join(CACHE_DIR, `${cacheKey(args)}.json`), JSON.stringify({ savedAt: Date.now(), result }, null, 2));
}

function makeCommonRequest(args: FetchArgs, credentials: Credentials): Record<string, unknown> {
	const timeoutMs = Math.max(1000, Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120000));
	const rejectRequestPattern = [
		...(args.rejectRequestPattern ?? []),
		...(args.clean?.rejectRequestPattern ?? []),
	].filter(Boolean);
	const request: Record<string, unknown> = {
		account_id: credentials.accountId,
		url: normalizeUrl(args.url),
		userAgent: args.userAgent?.trim() || DEFAULT_USER_AGENT,
		gotoOptions: { waitUntil: args.waitUntil ?? DEFAULT_WAIT_UNTIL, timeout: timeoutMs },
		actionTimeout: timeoutMs,
		cacheTTL: args.fresh ? 0 : 5,
	};
	if (args.viewport) request.viewport = args.viewport;
	if (args.headers) request.setExtraHTTPHeaders = args.headers;
	if (rejectRequestPattern.length) request.rejectRequestPattern = rejectRequestPattern;
	const selector = args.waitForSelector ?? args.extract?.selector;
	if (selector?.trim()) request.waitForSelector = { selector: selector.trim(), timeout: timeoutMs };
	if (args.actions?.length) {
		request.addScriptTag = [{ content: buildActionScript(args.actions) }];
	}
	return request;
}

function buildActionScript(actions: Action[]): string {
	return `(() => { window.__piWebFetchActions = async () => { const sleep = ms => new Promise(r => setTimeout(r, ms)); for (const a of ${JSON.stringify(actions)}) { if (a.type === 'wait') await sleep(a.ms || 0); if (a.type === 'waitForSelector') { for (let i=0;i<100;i++){ if(document.querySelector(a.selector)) break; await sleep(100); } } if (a.type === 'click') document.querySelector(a.selector)?.click(); if (a.type === 'type') { const el = document.querySelector(a.selector); if (el) { el.focus(); el.value = a.text || ''; el.dispatchEvent(new Event('input', {bubbles:true})); } } } }; window.__piWebFetchActions(); })();`;
}

function maybeCleanHtml(html: string, clean?: CleanOptions): string {
	let out = html;
	for (const selector of clean?.removeSelectors ?? []) {
		// Conservative fallback: Cloudflare does not support DOM post-processing in Quick Actions.
		// Remove only simple class/id/tag selectors from returned HTML.
		const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (selector.startsWith(".")) out = out.replace(new RegExp(`<[^>]*class=["'][^"']*${escaped.slice(2)}[^"']*["'][^>]*>[\\s\\S]*?<\\/[^>]+>`, "gi"), "");
		else if (selector.startsWith("#")) out = out.replace(new RegExp(`<[^>]*id=["']${escaped.slice(2)}["'][^>]*>[\\s\\S]*?<\\/[^>]+>`, "gi"), "");
		else if (/^[a-z][a-z0-9-]*$/i.test(selector)) out = out.replace(new RegExp(`<${selector}\\b[^>]*>[\\s\\S]*?<\\/${selector}>`, "gi"), "");
	}
	return out;
}

async function callCloudflare(args: FetchArgs, signal?: AbortSignal): Promise<FetchResult> {
	const cached = readCache(args);
	if (cached) return cached;

	const credentials = loadCredentials();
	if (!credentials) throw new Error(credentialHelp());
	const started = Date.now();
	const client = new Cloudflare({ apiToken: credentials.apiToken });
	const format = args.format ?? DEFAULT_FORMAT;
	const request = makeCommonRequest(args, credentials);
	const options = { signal, timeout: (args.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 5000 };
	let content = "";
	let title = titleFromUrl(request.url as string);

	try {
		if (args.extract?.selector && ["markdown", "html", "text"].includes(format)) {
			const scrapeReq = { ...request, elements: [{ selector: args.extract.selector }] };
			const scraped = await client.browserRendering.scrape.create(scrapeReq as any, options);
			const first = Array.isArray(scraped) ? scraped[0]?.results : undefined;
			if (!first) throw new Error(`No element matched selector: ${args.extract.selector}`);
			content = format === "html" ? first.html : format === "text" ? first.text : htmlToText(first.html);
		} else if (format === "markdown") {
			content = (await client.browserRendering.markdown.create(request as any, options)).trim();
		} else if (format === "html" || format === "text") {
			const html = maybeCleanHtml(await client.browserRendering.content.create(request as any, options), args.clean);
			content = format === "html" ? html : htmlToText(html);
		} else if (format === "links") {
			const links = await client.browserRendering.links.create(request as any, options);
			content = (links as string[]).map((l, i) => `${i + 1}. ${l}`).join("\n");
		} else if (format === "json") {
			const jsonReq = { ...request };
			if (args.structured?.prompt) jsonReq.prompt = args.structured.prompt;
			if (args.structured?.schema) jsonReq.response_format = { type: "json_schema", json_schema: { name: "web_fetch_schema", schema: args.structured.schema } };
			content = JSON.stringify(await client.browserRendering.json.create(jsonReq as any, options), null, 2);
		} else if (format === "snapshot") {
			const snapReq = { ...request, formats: ["markdown", "content", "screenshot"] };
			content = JSON.stringify(await client.browserRendering.snapshot.create(snapReq as any, options), null, 2);
		} else if (format === "screenshot") {
			const shotReq = { ...request, screenshotOptions: { type: "png", fullPage: true, encoding: "base64" } };
			content = JSON.stringify(await client.browserRendering.screenshot.create(shotReq as any, options), null, 2);
		} else if (format === "pdf") {
			const response = await client.browserRendering.pdf.create(request as any, options);
			const buffer = Buffer.from(await response.arrayBuffer());
			content = `data:application/pdf;base64,${buffer.toString("base64")}`;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Cloudflare Browser Run ${format} failed: ${message}`);
	}

	if (args.extract?.includeLinks && ["markdown", "html", "text"].includes(format)) {
		const links = await client.browserRendering.links.create(request as any, options);
		content += `\n\n---\n\n## Links\n\n${(links as string[]).map((l, i) => `${i + 1}. ${l}`).join("\n")}`;
	}
	if (args.extract?.includeImages && ["markdown", "html", "text"].includes(format)) {
		const imagesReq = { ...request, elements: [{ selector: "img" }] };
		const images = await client.browserRendering.scrape.create(imagesReq as any, options);
		const imageLines = (images as Array<{ results?: { attributes?: Array<{ name: string; value: string }> } }>)
			.map((img, i) => {
				const attrs = img.results?.attributes ?? [];
				const src = attrs.find((a) => a.name === "src")?.value;
				const alt = attrs.find((a) => a.name === "alt")?.value;
				return src ? `${i + 1}. ${alt ? `${alt} — ` : ""}${src}` : "";
			})
			.filter(Boolean)
			.join("\n");
		if (imageLines) content += `\n\n---\n\n## Images\n\n${imageLines}`;
	}

	if (!content.trim()) throw new Error("Cloudflare Browser Run returned empty content.");
	if (format === "markdown") title = extractHeadingTitle(content) ?? title;
	const result: FetchResult = { url: request.url as string, title, content, format, source: "cloudflare-browser-run", cached: false, renderMs: Date.now() - started };
	writeCache(args, result);
	return result;
}

function contentHeader(result: FetchResult, args: FetchArgs): string {
	if (result.format === "screenshot" || result.format === "pdf" || result.format === "json" || result.format === "snapshot") {
		return `Source: ${result.url}\nFormat: ${result.format}\nRendered by: Cloudflare Browser Run\n\n---\n\n`;
	}
	const hasTitle = result.format === "markdown" && /^#\s+/m.test(result.content.slice(0, 200));
	const lines = [hasTitle ? null : `# ${result.title}`, `Source: ${result.url}`, `Format: ${result.format}`, `Rendered by: Cloudflare Browser Run`, args.metadata ? `Render time: ${result.renderMs}ms${result.cached ? " (cached)" : ""}` : null, "---"];
	return lines.filter(Boolean).join("\n\n") + "\n\n";
}

export default function (pi: ExtensionAPI) {
	return
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: "Fetch a web page through Cloudflare Browser Run and return markdown, html, text, links, screenshot, pdf, snapshot, or structured json.",
		promptSnippet: "Fetch a URL with Cloudflare Browser Run. Use format='markdown' by default; use waitUntil='networkidle0' or waitForSelector for SPAs.",
		promptGuidelines: [
			"Use format='markdown' for readable page content unless another format is explicitly needed.",
			"If content is incomplete, retry with waitUntil='networkidle0' or waitForSelector targeting main content.",
			"Use cache.fresh=true or fresh=true when the user needs current/live content.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "HTTP(S) URL to fetch" }),
			format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("html"), Type.Literal("text"), Type.Literal("links"), Type.Literal("screenshot"), Type.Literal("pdf"), Type.Literal("snapshot"), Type.Literal("json")], { description: "Output format (default: markdown)." })),
			waitUntil: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle0"), Type.Literal("networkidle2")], { description: "Navigation wait strategy (default: networkidle2)." })),
			waitForSelector: Type.Optional(Type.String({ description: "CSS selector to wait for before extraction." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Overall render timeout in milliseconds (default: 60000, max: 120000).", minimum: 1000, maximum: 120000 })),
			userAgent: Type.Optional(Type.String({ description: "Browser user agent override." })),
			rejectRequestPattern: Type.Optional(Type.Array(Type.String(), { description: "Regex strings for requests to block." })),
			viewport: Type.Optional(Type.Object({ width: Type.Number(), height: Type.Number(), deviceScaleFactor: Type.Optional(Type.Number()), isMobile: Type.Optional(Type.Boolean()), hasTouch: Type.Optional(Type.Boolean()), isLandscape: Type.Optional(Type.Boolean()) }, { description: "Viewport used while rendering." })),
			headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra HTTP headers sent by the browser page." })),
			cache: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean()), ttlSeconds: Type.Optional(Type.Number({ minimum: 0 })) }, { description: "Local extension cache options. Default: enabled for text-like formats, 1h TTL." })),
			fresh: Type.Optional(Type.Boolean({ description: "Bypass local cache and Cloudflare short cache." })),
			extract: Type.Optional(Type.Object({ selector: Type.Optional(Type.String()), includeLinks: Type.Optional(Type.Boolean()), includeImages: Type.Optional(Type.Boolean()) }, { description: "Extraction options. selector uses Browser Run scrape for markdown/html/text." })),
			clean: Type.Optional(Type.Object({ removeSelectors: Type.Optional(Type.Array(Type.String())), rejectRequestPattern: Type.Optional(Type.Array(Type.String())) }, { description: "Noise removal options." })),
			metadata: Type.Optional(Type.Boolean({ description: "Include render metadata in the returned text and details." })),
			structured: Type.Optional(Type.Object({ prompt: Type.Optional(Type.String()), schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, { description: "Options for format='json'." })),
			actions: Type.Optional(Type.Array(Type.Object({ type: Type.Union([Type.Literal("click"), Type.Literal("type"), Type.Literal("waitForSelector"), Type.Literal("wait")]), selector: Type.Optional(Type.String()), text: Type.Optional(Type.String()), ms: Type.Optional(Type.Number()) }), { description: "Experimental pre-extraction actions injected into the page." })),
		}),
		async execute(_toolCallId, params: FetchArgs, signal) {
			const result = await callCloudflare(params, signal);
			return {
				content: [{ type: "text" as const, text: contentHeader(result, params) + result.content }],
				details: { url: result.url, title: result.title, chars: result.content.length, source: result.source, format: result.format, cached: result.cached, renderMs: result.renderMs, waitUntil: params.waitUntil ?? DEFAULT_WAIT_UNTIL, waitForSelector: params.waitForSelector ?? params.extract?.selector, viewport: params.viewport },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const { url, format, waitUntil, waitForSelector, extract } = args as FetchArgs;
			if (!url) { text.setText(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)")); return text; }
			const display = url.length > 70 ? url.slice(0, 67) + "..." : url;
			const lines = [theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display) + theme.fg("dim", ` as ${format ?? DEFAULT_FORMAT} via Cloudflare`)];
			if (waitUntil) lines.push(theme.fg("dim", `  waitUntil: ${waitUntil}`));
			if (waitForSelector ?? extract?.selector) lines.push(theme.fg("dim", `  selector: ${waitForSelector ?? extract?.selector}`));
			text.setText(lines.join("\n"));
			return text;
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (isPartial) { text.setText(theme.fg("warning", "Rendering with Cloudflare Browser Run…")); return text; }
			if (context.isError) { text.setText(theme.fg("error", result.content.find((c) => c.type === "text")?.text || "Error")); return text; }
			const details = result.details as { title?: string; chars?: number; format?: string; cached?: boolean; renderMs?: number };
			const status = theme.fg("success", details?.title || details?.format || "Fetched") + theme.fg("muted", ` (${details?.chars ?? 0} chars, ${details?.format ?? "markdown"}${details?.cached ? ", cached" : ""})`);
			if (!expanded) { text.setText(status); return text; }
			const content = result.content.find((c) => c.type === "text")?.text || "";
			text.setText(status + "\n" + theme.fg("dim", content.length > 500 ? content.slice(0, 500) + "..." : content));
			return text;
		},
	});
}
