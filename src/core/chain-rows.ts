/**
 * THE CHAIN ROWS — the pure half of the chain table (components/
 * chain-table.tsx). The desktop table and the phone app share it, so both
 * show the same groups, the same order and the same labels. Pure and
 * browser-safe: no DOM, no React, no `node:` import. The phone imports
 * this file directly.
 *
 * The laws (owner rulings, kept from the table):
 * - A chain lives in the source (chat or notes file) where its CONCLUSION
 *   was born. Unlabeled births form one muted group.
 * - Practice sessions are hidden. Their nodes stay visible in the other
 *   groups (shared premises).
 * - The fuzzy search matches node names, aliases and statements, and the
 *   source and folder names. Chains rank by the best member score. Sources
 *   auto-expand while a search is active.
 * - All three columns sort (name, props, created). The active column
 *   orders both the source groups and the chains in each group. The name
 *   (ascending) is the tiebreak. Unlabeled groups sort last under name.
 * - A label comes from the directory, then the session title, then the
 *   notes file name. A missing label shows "unlabeled".
 */

import { chainsForSelection, type ReasoningChain } from "./chains.ts";
import type { GraphChain, GraphNode } from "./contracts/graph.ts";
import { fuzzyScore } from "./fuzzy.ts";
import { sourceFileLabel } from "./source-label.ts";
import { chainSourceDirectory, placementOf, type SourceDirectory, type SourceEntry } from "./source-organization.ts";

/** The sortable columns (owner ruling: all three — consistency). */
export type ChainSortCol = "name" | "props" | "created";
export interface ChainSort {
	col: ChainSortCol;
	/** 1 = ascending (A→Z, oldest-first, smallest-first), -1 = descending. */
	dir: 1 | -1;
}

/** The table opens sorted by name, A→Z. */
export const DEFAULT_CHAIN_SORT: ChainSort = { col: "name", dir: 1 };

/** The display text for a source without a label. */
export const UNLABELED_SOURCE = "unlabeled";

/** The group key for chains whose conclusion has no birth. */
export const UNLABELED_GROUP_KEY = "\0unlabeled";

/** A click on the active column flips the direction. A click on a new
 *  column starts at name A→Z, or at largest/newest first for the others. */
export function nextChainSort(previous: ChainSort, col: ChainSortCol): ChainSort {
	return previous.col === col
		? { col, dir: previous.dir === 1 ? -1 : 1 }
		: { col, dir: col === "name" ? 1 : -1 };
}

/** A source group: the chains whose conclusion was born in one source. */
export interface ChainSourceGroup {
	key: string;
	birth: string | null;
	label: string | null;
	kind: "chat" | "notes" | null;
	chains: ReasoningChain[];
	nodeIds: string[];
	newestCreatedAt: string;
}

type NodeIndex = ReadonlyMap<string, GraphNode>;
type SourceRecords = ReadonlyMap<string, Pick<SourceEntry, "label" | "createdAt">>;

/** The display text of a source label. */
export function sourceDisplayName(label: string | null): string {
	return label ?? UNLABELED_SOURCE;
}

/** The label fallback: directory label, then session title, then notes file name. */
export function chainSourceLabel(birth: string, records: SourceRecords, sessions: Readonly<Record<string, string>>,
	fileSources: Readonly<Record<string, string>>): string | null {
	return records.get(birth)?.label ?? sessions[birth] ?? (fileSources[birth] === undefined ? null : sourceFileLabel(fileSources[birth]));
}

/** The birth source of a chain: the first provenance of its conclusion. */
export function chainBirth(chain: Pick<ReasoningChain, "conclusion">, byId: NodeIndex): string | undefined {
	return byId.get(chain.conclusion)?.provenance[0]?.chatId;
}

/** The ids of the practice sessions in the full directory (hidden from the table). */
export function practiceSourceIds(directory: SourceDirectory | undefined): Set<string> {
	return new Set(directory?.sources.filter((s) => s.chatKind === "practice").map((s) => s.id));
}

/** Filter source groups, not global nodes: shared premises remain visible
 *  in teaching/notes groups. */
export function chainsOutsideSources(chains: readonly ReasoningChain[], byId: NodeIndex, hidden: ReadonlySet<string>): ReasoningChain[] {
	return chains.filter((chain) => !hidden.has(chainBirth(chain, byId) ?? ""));
}

/** Every member node of each birth source, before the search filter. */
export function sourceNodeMembership(chains: readonly ReasoningChain[], byId: NodeIndex): Map<string, Set<string>> {
	const membership = new Map<string, Set<string>>();
	for (const chain of chains) {
		const birth = chainBirth(chain, byId);
		if (!birth) continue;
		const members = membership.get(birth) ?? new Set<string>();
		for (const id of [...chain.premises, chain.conclusion]) members.add(id);
		membership.set(birth, members);
	}
	return membership;
}

/** Source/folder names are also searchable, including sources without nodes. */
export function sourceNameMatches(directory: SourceDirectory | undefined, id: string, label: string | null, query: string): boolean {
	if (!query.trim()) return true;
	if (fuzzyScore(query, label ?? "") !== null) return true;
	if (!directory) return false;
	let parent = placementOf(directory.organization, id)?.folderId ?? null;
	const seen = new Set<string>();
	while (parent !== null && !seen.has(parent)) {
		seen.add(parent);
		const folder = directory.organization.folders.find((f) => f.id === parent);
		if (!folder) break;
		if (fuzzyScore(query, folder.name) !== null) return true;
		parent = folder.parentId;
	}
	return false;
}

/** True when the query has text (a search is active). */
export function isChainSearch(query: string): boolean {
	return query.trim() !== "";
}

/** The fuzzy filter: a chain is visible when ANY member matches on name,
 *  aliases, or statement, or when its birth source name matches (score 0).
 *  Chains rank by best member score, then by id. No query keeps all chains. */
export function searchChains(chains: readonly ReasoningChain[], byId: NodeIndex, query: string,
	matchesSource: (birth: string) => boolean): ReasoningChain[] {
	if (!isChainSearch(query)) return [...chains];
	const scored = chains
		.map((chain) => {
			const birth = chainBirth(chain, byId);
			let best: number | null = birth && matchesSource(birth) ? 0 : null;
			for (const id of [...chain.premises, chain.conclusion]) {
				const node = byId.get(id);
				if (!node) continue;
				const s = fuzzyScore(query, node.name, node.statement, ...node.aliases);
				if (s === null) continue;
				if (best === null || s > best) best = s;
			}
			return best === null ? null : { chain, best };
		})
		.filter((r): r is { chain: ReasoningChain; best: number } => r !== null);
	return scored
		.sort((a, b) => b.best - a.best || (a.chain.id < b.chain.id ? -1 : 1))
		.map(({ chain }) => chain);
}

/** One collator for every name comparison (numeric, base sensitivity). */
export function chainNameCollator(): Intl.Collator {
	return new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
}

export interface GroupChainsInput {
	visibleChains: readonly ReasoningChain[];
	byId: NodeIndex;
	sessions: Readonly<Record<string, string>>;
	fileSources: Readonly<Record<string, string>>;
	sort: ChainSort;
	/** The chain directory (practice sources already removed). */
	directory?: SourceDirectory;
	sourceRecords: SourceRecords;
	searching: boolean;
	matchesSource: (birth: string) => boolean;
	/** Session kinds must arrive before provenance-only source rows can render. */
	sourceInventoryPending?: boolean;
}

/** Group the visible chains by their CONCLUSION's birth, then sort the
 *  groups and the chains in each group by the active column. */
export function groupChainsBySource({ visibleChains, byId, sessions, fileSources, sort, directory, sourceRecords, searching,
	matchesSource, sourceInventoryPending = false }: GroupChainsInput): ChainSourceGroup[] {
	if (sourceInventoryPending) return [];
	const map = new Map<string, ChainSourceGroup>();
	for (const source of directory?.sources ?? []) {
		if (searching && !matchesSource(source.id)) continue;
		map.set(source.id, { key: source.id, birth: source.id, label: source.label,
			kind: source.kind === "missing" ? null : source.kind, chains: [], nodeIds: [], newestCreatedAt: "" });
	}
	for (const chain of visibleChains) {
		const birth = chainBirth(chain, byId) ?? null;
		const key = birth ?? UNLABELED_GROUP_KEY;
		let group = map.get(key);
		if (!group) {
			const label = birth === null ? null : chainSourceLabel(birth, sourceRecords, sessions, fileSources);
			const kind =
				birth === null ? null : sessions[birth] !== undefined ? "chat" : fileSources[birth] !== undefined ? "notes" : null;
			group = { key, birth, label, kind, chains: [], nodeIds: [], newestCreatedAt: "" };
			map.set(key, group);
		}
		group.chains.push(chain);
		for (const id of [...chain.premises, chain.conclusion]) {
			if (!group.nodeIds.includes(id)) group.nodeIds.push(id);
			const createdAt = byId.get(id)?.createdAt ?? "";
			if (createdAt > group.newestCreatedAt) group.newestCreatedAt = createdAt;
		}
	}
	const collator = chainNameCollator();
	const list = [...map.values()];
	// Existing graph groups retain their newest-member date. Inventory-only
	// rows fall back to record dates; a re-import must not redraft old dates.
	for (const group of list) if (!group.newestCreatedAt && group.birth) group.newestCreatedAt = sourceRecords.get(group.birth)?.createdAt ?? "";
	// Unlabeled groups sort last under name-sort (U+FFFF sentinel).
	const nameKey = (g: ChainSourceGroup) => g.label ?? "￿";
	const cmpName = (a: ChainSourceGroup, b: ChainSourceGroup) => collator.compare(nameKey(a), nameKey(b)) * (sort.col === "name" ? sort.dir : 1);
	const cmpProps = (a: ChainSourceGroup, b: ChainSourceGroup) =>
		sort.dir === -1 ? b.nodeIds.length - a.nodeIds.length : a.nodeIds.length - b.nodeIds.length;
	const cmpCreated = (a: ChainSourceGroup, b: ChainSourceGroup) =>
		sort.dir === -1 ? b.newestCreatedAt.localeCompare(a.newestCreatedAt) : a.newestCreatedAt.localeCompare(b.newestCreatedAt);
	list.sort((a, b) =>
		sort.col === "created" ? cmpCreated(a, b) || cmpName(a, b) : sort.col === "props" ? cmpProps(a, b) || cmpName(a, b) : cmpName(a, b),
	);
	const chainName = (chain: ReasoningChain) => byId.get(chain.conclusion)?.name ?? chain.conclusion;
	const chainSize = (chain: ReasoningChain) => chain.premises.length + 1;
	const chainDate = (chain: ReasoningChain) => byId.get(chain.conclusion)?.createdAt ?? "";
	const cName = (a: ReasoningChain, b: ReasoningChain) => collator.compare(chainName(a), chainName(b)) * (sort.col === "name" ? sort.dir : 1);
	const cProps = (a: ReasoningChain, b: ReasoningChain) =>
		sort.dir === -1 ? chainSize(b) - chainSize(a) : chainSize(a) - chainSize(b);
	const cDate = (a: ReasoningChain, b: ReasoningChain) =>
		sort.dir === -1 ? chainDate(b).localeCompare(chainDate(a)) : chainDate(a).localeCompare(chainDate(b));
	for (const group of list) {
		group.chains.sort((a, b) =>
			sort.col === "created" ? cDate(a, b) || cName(a, b) : sort.col === "props" ? cProps(a, b) || cName(a, b) : cName(a, b),
		);
	}
	return list;
}

/** Sources auto-expand while a search is active, except the ones the user
 *  folded during this search. Without a search, only expanded sources open. */
export function isSourceOpen(key: string, state: { searching: boolean; expanded: ReadonlySet<string>; foldedForSearch: ReadonlySet<string> }): boolean {
	return state.searching ? !state.foldedForSearch.has(key) : state.expanded.has(key);
}

export interface ChainRowsInput {
	nodes: readonly GraphNode[];
	chains: readonly GraphChain[];
	sessions: Readonly<Record<string, string>>;
	fileSources: Readonly<Record<string, string>>;
	/** The FULL source directory (practice sources included); absent before it loads. */
	directory?: SourceDirectory;
	query: string;
	sort: ChainSort;
	sourceInventoryPending?: boolean;
}

export interface ChainRows {
	/** Every chain of the graph (the header counts). */
	chains: ReasoningChain[];
	/** The chain directory (practice sources removed). */
	directory?: SourceDirectory;
	/** Every member node of each birth source, before the search filter. */
	sourceNodes: Map<string, Set<string>>;
	searching: boolean;
	groups: ChainSourceGroup[];
}

/** The whole chain table derivation in one call (the phone uses this; the
 *  desktop table runs the same steps one by one, memoized). */
export function buildChainRows({ nodes, chains: storedChains, sessions, fileSources, directory: fullDirectory, query, sort,
	sourceInventoryPending = false }: ChainRowsInput): ChainRows {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const directory = fullDirectory && chainSourceDirectory(fullDirectory);
	const sourceRecords = new Map(directory?.sources.map((s) => [s.id, s]));
	const matchesSource = (birth: string) =>
		sourceNameMatches(directory, birth, chainSourceLabel(birth, sourceRecords, sessions, fileSources), query);
	const chains = chainsForSelection(nodes, storedChains);
	const sourceChains = chainsOutsideSources(chains, byId, practiceSourceIds(fullDirectory));
	const searching = isChainSearch(query);
	const visibleChains = searchChains(sourceChains, byId, query, matchesSource);
	const groups = groupChainsBySource({ visibleChains, byId, sessions, fileSources, sort, directory, sourceRecords, searching,
		matchesSource, sourceInventoryPending });
	return { chains, directory, sourceNodes: sourceNodeMembership(sourceChains, byId), searching, groups };
}
