/**
 * THE CHAIN ROWS (src/core/chain-rows.ts) — the pure half of the chain
 * table, shared with the phone app. These pins hold the sort law, the
 * fuzzy search, the label fallback, the unlabeled-last rule and the
 * practice filter. The SSR pins in render-chain-table.test.tsx hold the
 * table markup on top of the same code.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
	DEFAULT_CHAIN_SORT,
	UNLABELED_GROUP_KEY,
	buildChainRows,
	chainSourceLabel,
	isSourceOpen,
	nextChainSort,
	sourceDisplayName,
	sourceNameMatches,
	type ChainRowsInput,
	type ChainSort,
} from "../src/core/chain-rows.ts";
import type { GraphChain, GraphNode } from "../src/core/contracts/graph.ts";
import type { SourceDirectory } from "../src/core/source-organization.ts";

function node(id: string, name: string, chatId: string | null, createdAt = "2026-09-20T10:00:00.000Z", extra: Partial<GraphNode> = {}): GraphNode {
	return {
		id, name, statement: `Statement ${id}.`, aliases: [], createdAt,
		provenance: chatId === null ? [] : [{ chatId, messageId: `m_${id}` }],
		...extra,
	} as unknown as GraphNode;
}
const chain = (id: string, premises: string[], conclusion: string): GraphChain =>
	({ id, premises, conclusion, createdAt: "2026-09-20T10:00:00.000Z", provenance: [] }) as unknown as GraphChain;

/** chat "Beta" (2 chains), chat "alpha 10" and "alpha 9" (numeric order),
 *  notes file "notes/Gamma.md", one node without provenance, one practice. */
const NODES: GraphNode[] = [
	node("p1", "Premise one", "chat_beta", "2026-09-01T00:00:00.000Z"),
	node("c1", "Zeta conclusion", "chat_beta", "2026-09-02T00:00:00.000Z", { aliases: ["the zed"] }),
	node("c2", "Apple conclusion", "chat_beta", "2026-09-03T00:00:00.000Z"),
	node("a10", "Ten", "chat_a10", "2026-09-05T00:00:00.000Z"),
	node("a9", "Nine", "chat_a9", "2026-09-04T00:00:00.000Z"),
	node("g1", "Gamma fact", "src_gamma", "2026-09-06T00:00:00.000Z"),
	node("orphan", "Orphan", null, "2026-09-07T00:00:00.000Z"),
	node("pr1", "Practice only", "chat_practice", "2026-09-08T00:00:00.000Z"),
];
const CHAINS: GraphChain[] = [chain("arg_1", ["p1"], "c1")];
const SESSIONS = { chat_beta: "Beta", chat_a10: "alpha 10", chat_a9: "alpha 9", chat_practice: "Drill" };
const FILES = { src_gamma: "notes/Gamma.md" };
const DIRECTORY: SourceDirectory = {
	organization: { version: 1, folders: [{ id: "f_math", name: "Mathematics", parentId: null, createdAt: "2026-09-01T00:00:00.000Z" }],
		placements: { src_gamma: { folderId: "f_math" } } },
	sources: [{ id: "chat_practice", kind: "chat", chatKind: "practice", label: "Drill", createdAt: "2026-09-08T00:00:00.000Z" }],
};

const rows = (overrides: Partial<ChainRowsInput> = {}) => buildChainRows({
	nodes: NODES, chains: CHAINS, sessions: SESSIONS, fileSources: FILES, directory: DIRECTORY, query: "", sort: DEFAULT_CHAIN_SORT, ...overrides,
});
const labels = (sort: ChainSort, query = "") => rows({ sort, query }).groups.map((g) => sourceDisplayName(g.label));

describe("chain rows: sort", () => {
	it("a new column starts at name A→Z, or largest/newest first; the active column flips", () => {
		assert.deepEqual(DEFAULT_CHAIN_SORT, { col: "name", dir: 1 });
		assert.deepEqual(nextChainSort(DEFAULT_CHAIN_SORT, "name"), { col: "name", dir: -1 });
		assert.deepEqual(nextChainSort(DEFAULT_CHAIN_SORT, "props"), { col: "props", dir: -1 });
		assert.deepEqual(nextChainSort({ col: "props", dir: -1 }, "props"), { col: "props", dir: 1 });
		assert.deepEqual(nextChainSort({ col: "props", dir: 1 }, "created"), { col: "created", dir: -1 });
		assert.deepEqual(nextChainSort({ col: "created", dir: -1 }, "name"), { col: "name", dir: 1 });
	});

	it("name sorts with the numeric, case-insensitive collator; unlabeled sorts last in both directions", () => {
		assert.deepEqual(labels({ col: "name", dir: 1 }), ["alpha 9", "alpha 10", "Beta", "Gamma", "unlabeled"]);
		// Descending reverses the labels; the unlabeled sentinel (U+FFFF) flips to first.
		assert.deepEqual(labels({ col: "name", dir: -1 }), ["unlabeled", "Gamma", "Beta", "alpha 10", "alpha 9"]);
	});

	it("props sorts by node count with the name (ascending) as the tiebreak", () => {
		assert.deepEqual(labels({ col: "props", dir: -1 }), ["Beta", "alpha 9", "alpha 10", "Gamma", "unlabeled"]);
		assert.deepEqual(labels({ col: "props", dir: 1 }), ["alpha 9", "alpha 10", "Gamma", "unlabeled", "Beta"]);
	});

	it("created sorts by the newest member date", () => {
		assert.deepEqual(labels({ col: "created", dir: -1 }), ["unlabeled", "Gamma", "alpha 10", "alpha 9", "Beta"]);
		assert.deepEqual(labels({ col: "created", dir: 1 }), ["Beta", "alpha 9", "alpha 10", "Gamma", "unlabeled"]);
	});

	it("the chains in a group follow the active column", () => {
		const beta = (sort: ChainSort) => rows({ sort }).groups.find((g) => g.key === "chat_beta")!.chains.map((c) => c.conclusion);
		assert.deepEqual(beta({ col: "name", dir: 1 }), ["c2", "c1"]);
		assert.deepEqual(beta({ col: "name", dir: -1 }), ["c1", "c2"]);
		assert.deepEqual(beta({ col: "props", dir: -1 }), ["c1", "c2"]);
		assert.deepEqual(beta({ col: "created", dir: -1 }), ["c2", "c1"]);
		assert.deepEqual(beta({ col: "created", dir: 1 }), ["c1", "c2"]);
	});

	it("a group carries its member ids, its kind and its newest date", () => {
		const beta = rows().groups.find((g) => g.key === "chat_beta")!;
		assert.deepEqual([...beta.nodeIds].sort(), ["c1", "c2", "p1"]);
		assert.equal(beta.kind, "chat");
		assert.equal(beta.newestCreatedAt, "2026-09-03T00:00:00.000Z");
		assert.equal(rows().groups.find((g) => g.key === "src_gamma")!.kind, "notes");
	});
});

describe("chain rows: labels", () => {
	it("the label falls back from the directory to the session title to the notes file name", () => {
		const records = new Map([["chat_beta", { label: "Renamed", createdAt: null }]]);
		assert.equal(chainSourceLabel("chat_beta", records, SESSIONS, FILES), "Renamed");
		assert.equal(chainSourceLabel("chat_beta", new Map(), SESSIONS, FILES), "Beta");
		assert.equal(chainSourceLabel("src_gamma", new Map(), SESSIONS, FILES), "Gamma");
		assert.equal(chainSourceLabel("chat_gone", new Map(), SESSIONS, FILES), null);
		assert.equal(sourceDisplayName(null), "unlabeled");
		assert.equal(sourceDisplayName("Beta"), "Beta");
	});

	it("a conclusion without provenance goes to the one unlabeled group", () => {
		const group = rows().groups.find((g) => g.key === UNLABELED_GROUP_KEY)!;
		assert.equal(group.birth, null);
		assert.equal(group.label, null);
		assert.equal(group.kind, null);
		assert.deepEqual(group.nodeIds, ["orphan"]);
	});

	it("a directory label wins over the session title", () => {
		const directory: SourceDirectory = { ...DIRECTORY, sources: [...DIRECTORY.sources,
			{ id: "chat_beta", kind: "chat", label: "Renamed beta", createdAt: "2026-09-01T00:00:00.000Z" }] };
		assert.ok(rows({ directory }).groups.some((g) => g.key === "chat_beta" && g.label === "Renamed beta"));
	});
});

describe("chain rows: practice sources", () => {
	it("hides practice births but keeps the graph-wide chain count", () => {
		const result = rows();
		assert.ok(!result.groups.some((g) => g.key === "chat_practice"));
		assert.ok(result.chains.some((c) => c.conclusion === "pr1"), "the header counts every chain");
		assert.ok(!result.directory!.sources.some((s) => s.id === "chat_practice"));
		assert.ok(!result.sourceNodes.has("chat_practice"));
	});

	it("without the directory, the practice session shows as a plain chat", () => {
		assert.ok(rows({ directory: undefined }).groups.some((g) => g.key === "chat_practice"));
	});
});

describe("chain rows: search", () => {
	it("an empty or blank query keeps every source", () => {
		assert.equal(rows({ query: "   " }).searching, false);
		assert.equal(rows({ query: "   " }).groups.length, 5);
	});

	it("matches names, aliases and statements; non-matching sources hide", () => {
		assert.deepEqual(labels(DEFAULT_CHAIN_SORT, "zeta"), ["Beta"]);
		assert.deepEqual(labels(DEFAULT_CHAIN_SORT, "zed"), ["Beta"]);
		assert.deepEqual(labels(DEFAULT_CHAIN_SORT, "statement a10"), ["alpha 10"]);
		assert.deepEqual(labels(DEFAULT_CHAIN_SORT, "no such thing"), []);
	});

	it("a premise match keeps its chain", () => {
		const beta = rows({ query: "premise" }).groups.find((g) => g.key === "chat_beta")!;
		assert.deepEqual(beta.chains.map((c) => c.id), ["arg_1"]);
	});

	it("a source name match and a folder name match keep the whole source", () => {
		const beta = rows({ query: "beta" }).groups.find((g) => g.key === "chat_beta")!;
		assert.equal(beta.chains.length, 2);
		assert.deepEqual(labels(DEFAULT_CHAIN_SORT, "mathem"), ["Gamma"]);
		assert.equal(sourceNameMatches(DIRECTORY, "src_gamma", "Gamma", "mathematics"), true);
		assert.equal(sourceNameMatches(DIRECTORY, "src_gamma", "Gamma", "physics"), false);
		assert.equal(sourceNameMatches(undefined, "src_gamma", "Gamma", "mathematics"), false);
		assert.equal(sourceNameMatches(undefined, "x", null, ""), true);
	});

	it("the search ranks chains by the best member score before the sort", () => {
		// Both Beta chains match "conclusion"; the in-group order is still the active sort.
		const beta = rows({ query: "conclusion" }).groups.find((g) => g.key === "chat_beta")!;
		assert.deepEqual(beta.chains.map((c) => c.conclusion), ["c2", "c1"]);
	});

	it("sources auto-expand while searching, unless the user folded them", () => {
		const expanded = new Set(["a"]);
		const folded = new Set(["b"]);
		assert.equal(isSourceOpen("a", { searching: false, expanded, foldedForSearch: folded }), true);
		assert.equal(isSourceOpen("c", { searching: false, expanded, foldedForSearch: folded }), false);
		assert.equal(isSourceOpen("c", { searching: true, expanded, foldedForSearch: folded }), true);
		assert.equal(isSourceOpen("b", { searching: true, expanded, foldedForSearch: folded }), false);
	});

	it("a pending source inventory renders no groups", () => {
		assert.deepEqual(rows({ sourceInventoryPending: true }).groups, []);
	});
});

describe("chain rows: the golden graph", () => {
	const graphDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "golden-data", "graph");
	const readJsonl = <T>(file: string): T[] => fs.readFileSync(path.join(graphDir, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
	// The node ledger can repeat an id; the last record wins.
	const nodes = [...new Map(readJsonl<GraphNode>("nodes.jsonl").map((n) => [n.id, n])).values()];
	const chains = readJsonl<GraphChain>("chains.jsonl");
	const sources = JSON.parse(fs.readFileSync(path.join(graphDir, "sources.json"), "utf8")) as Record<string, { filePath: string }>;
	const fileSources = Object.fromEntries(Object.entries(sources).map(([id, s]) => [id, s.filePath]));

	it("every chain sits in exactly one group, and notes groups carry the file names", () => {
		const result = buildChainRows({ nodes, chains, sessions: {}, fileSources, query: "", sort: DEFAULT_CHAIN_SORT });
		const placed = result.groups.flatMap((g) => g.chains.map((c) => c.id));
		assert.equal(placed.length, result.chains.length);
		assert.equal(new Set(placed).size, placed.length);
		const notes = result.groups.filter((g) => g.kind === "notes").map((g) => g.label);
		assert.deepEqual(notes, ["learn computer", "learn database", "learning libertarianism", "learning software architecture"]);
		// Chat births without a session title show "unlabeled" and sort after the named notes.
		const firstUnnamed = result.groups.findIndex((g) => g.label === null);
		assert.ok(firstUnnamed >= notes.length);
		assert.ok(result.groups.slice(firstUnnamed).every((g) => g.label === null));
	});
});
