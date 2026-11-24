/**
 * THE FOLDER ORDER — the pure half of the source folder tree (components/
 * source-folder-tree.tsx). The desktop tree and the phone app share it, so
 * both show the same folders, in the same order, with the same counts.
 * Pure and browser-safe: no DOM, no React, no `node:` import. The phone
 * imports this file directly.
 *
 * The laws (kept from the tree):
 * - A source sits in the folder of its placement. A source with no birth
 *   or no placement sits at the top level.
 * - At each level, folders and sources mix and sort by the active column.
 *   The name is the tiebreak, then the id. A source with no label sorts
 *   last under name (U+FFFF sentinel).
 * - A source counts its own nodes. A folder counts the distinct nodes of
 *   all sources below it, at any depth.
 * - During a search, a folder shows when a source below it is visible, its
 *   own name matches, or a child folder shows.
 */

import type { ChainSort } from "./chain-rows.ts";
import { fuzzyScore } from "./fuzzy.ts";
import { placementOf, type SourceFolder, type SourceOrganization } from "./source-organization.ts";

/** The fields of a source that the folder order reads. */
export interface FolderTreeSource {
	key: string;
	birth: string | null;
	label: string | null;
	nodeIds: readonly string[];
	newestCreatedAt: string;
}

/** One entry of a folder level: a source or a folder. */
export type FolderLevelItem<T extends FolderTreeSource> =
	| { kind: "source"; source: T; id: string; name: string; count: number; date: string }
	| { kind: "folder"; folder: SourceFolder; id: string; name: string; count: number; date: string };

export interface FolderTreeInput<T extends FolderTreeSource> {
	/** The visible sources (after the search filter). */
	groups: readonly T[];
	organization: SourceOrganization;
	query: string;
	sort: ChainSort;
	/** Every member node of each birth source, before the search filter.
	 *  When present, folder counts use it instead of `groups`. */
	allSourceNodes?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface FolderTree<T extends FolderTreeSource> {
	/** The folder that holds a source, or null for the top level. */
	parentOf: (source: Pick<T, "birth">) => string | null;
	/** True when the source is in the folder or in a folder below it. */
	isInFolder: (source: Pick<T, "birth">, folderId: string) => boolean;
	/** The distinct node ids of all sources below the folder. */
	folderNodeIds: (folderId: string) => string[];
	/** False only during a search, for a folder with no match below it. */
	isFolderVisible: (folderId: string) => boolean;
	/** True when the folder has a visible child folder or a visible source. */
	hasChildren: (folderId: string) => boolean;
	/** The sorted entries of one level (null is the top level). */
	level: (parentId: string | null) => FolderLevelItem<T>[];
}

/** The folder order of one tree. */
export function folderTree<T extends FolderTreeSource>({ groups, organization, query, sort, allSourceNodes }: FolderTreeInput<T>): FolderTree<T> {
	const search = query.trim() !== "";
	const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
	const folderById = new Map(organization.folders.map((f) => [f.id, f]));
	const parentOf = (source: Pick<T, "birth">): string | null =>
		source.birth === null ? null : placementOf(organization, source.birth)?.folderId ?? null;
	const isInFolder = (source: Pick<T, "birth">, folderId: string): boolean => {
		const seen = new Set<string>();
		for (let parent = parentOf(source); parent !== null && !seen.has(parent); parent = folderById.get(parent)?.parentId ?? null) {
			if (parent === folderId) return true;
			seen.add(parent);
		}
		return false;
	};
	const folderNodeIds = (folderId: string): string[] => [...new Set(allSourceNodes
		? [...allSourceNodes].filter(([birth]) => isInFolder({ birth }, folderId)).flatMap(([, nodes]) => [...nodes])
		: groups.filter((g) => isInFolder(g, folderId)).flatMap((g) => g.nodeIds))];
	const visible = (id: string, seen: ReadonlySet<string>): boolean => !search || groups.some((g) => isInFolder(g, id))
		|| (folderById.has(id) && fuzzyScore(query, folderById.get(id)!.name) !== null)
		|| organization.folders.some((f) => f.parentId === id && !seen.has(f.id) && visible(f.id, new Set([...seen, f.id])));
	const isFolderVisible = (folderId: string): boolean => visible(folderId, new Set([folderId]));
	const hasChildren = (folderId: string): boolean =>
		organization.folders.some((f) => f.parentId === folderId && isFolderVisible(f.id)) || groups.some((g) => parentOf(g) === folderId);
	const level = (parentId: string | null): FolderLevelItem<T>[] => {
		const items: FolderLevelItem<T>[] = [
			...groups.filter((g) => parentOf(g) === parentId).map((g) => ({
				kind: "source" as const, source: g, id: g.key, name: g.label ?? "￿", count: g.nodeIds.length, date: g.newestCreatedAt,
			})),
			...organization.folders.filter((f) => f.parentId === parentId && isFolderVisible(f.id)).map((f) => ({
				kind: "folder" as const, folder: f, id: f.id, name: f.name, count: folderNodeIds(f.id).length, date: f.createdAt,
			})),
		];
		items.sort((a, b) => {
			const byName = collator.compare(a.name, b.name);
			const byCol = sort.col === "name" ? byName : sort.col === "props" ? a.count - b.count : a.date.localeCompare(b.date);
			return byCol * sort.dir || byName || a.id.localeCompare(b.id);
		});
		return items;
	};
	return { parentOf, isInFolder, folderNodeIds, isFolderVisible, hasChildren, level };
}
