/**
 * THE FOLDER ORDER (src/core/folder-order.ts): the pure half of the source
 * folder tree, shared with the phone app. These pins hold the mixed sort at
 * each level, the folder counts, the search filter and the cycle guard. The
 * SSR pins in render-source-folders.test.tsx hold the tree markup on top of
 * the same code.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { folderTree, type FolderTreeInput, type FolderTreeSource } from "../src/core/folder-order.ts";
import type { SourceOrganization } from "../src/core/source-organization.ts";

const organization: SourceOrganization = {
	version: 1,
	folders: [
		{ id: "f-db", name: "Databases", parentId: null, createdAt: "2026-10-02" },
		{ id: "f-pg", name: "Postgres", parentId: "f-db", createdAt: "2026-10-03" },
		{ id: "f-alg", name: "algebra", parentId: null, createdAt: "2026-10-01" },
		{ id: "f-empty", name: "Empty", parentId: null, createdAt: "2026-10-04" },
	],
	placements: { s2: { folderId: "f-db" }, s3: { folderId: "f-pg" }, s4: { folderId: "f-pg" } },
};

function source(key: string, label: string | null, nodeIds: string[], newestCreatedAt = "2026-10-10"): FolderTreeSource {
	return { key, birth: key, label, nodeIds, newestCreatedAt };
}

const groups = [
	source("s1", "Calculus 10", ["a"], "2026-10-05"),
	source("s2", "Indexes", ["b", "c"], "2026-10-06"),
	source("s3", "MVCC", ["c", "d"], "2026-10-07"),
	source("s4", "Vacuum", ["e"], "2026-10-08"),
	source("s5", null, ["f"], "2026-10-09"),
	source("s6", "Calculus 9", [], "2026-10-01"),
];

const tree = (input: Partial<FolderTreeInput<FolderTreeSource>> = {}) =>
	folderTree({ groups, organization, query: "", sort: { col: "name", dir: 1 }, ...input });
const ids = (input: Partial<FolderTreeInput<FolderTreeSource>>, parentId: string | null) => tree(input).level(parentId).map((i) => i.id);

describe("folder order", () => {
	it("mixes folders and sources at each level, sorted by name with numbers in order, unlabeled last", () => {
		assert.deepEqual(ids({}, null), ["f-alg", "s6", "s1", "f-db", "f-empty", "s5"]);
		assert.deepEqual(ids({}, "f-db"), ["s2", "f-pg"]);
		assert.deepEqual(ids({}, "f-pg"), ["s3", "s4"]);
		assert.deepEqual(ids({}, "f-empty"), []);
	});

	it("a name descending sort reverses the level", () => {
		assert.deepEqual(ids({ sort: { col: "name", dir: -1 } }, null), ["s5", "f-empty", "f-db", "s1", "s6", "f-alg"]);
	});

	it("sorts by count or date, with the name and then the id as the tiebreak", () => {
		// Counts: f-alg 0, s6 0, s1 1, f-db 4 (b, c, d, e), f-empty 0, s5 1.
		assert.deepEqual(ids({ sort: { col: "props", dir: 1 } }, null), ["f-alg", "s6", "f-empty", "s1", "s5", "f-db"]);
		assert.deepEqual(ids({ sort: { col: "props", dir: -1 } }, null), ["f-db", "s1", "s5", "f-alg", "s6", "f-empty"]);
		assert.deepEqual(ids({ sort: { col: "created", dir: -1 } }, null), ["s5", "s1", "f-empty", "f-db", "f-alg", "s6"]);
		const twins = [source("b", "Same", []), source("a", "Same", [])];
		assert.deepEqual(ids({ groups: twins, organization: { version: 1, folders: [], placements: {} } }, null), ["a", "b"]);
	});

	it("a folder counts the distinct nodes of all sources below it", () => {
		const t = tree();
		assert.deepEqual(t.folderNodeIds("f-db").sort(), ["b", "c", "d", "e"]);
		assert.deepEqual(t.folderNodeIds("f-pg").sort(), ["c", "d", "e"]);
		assert.equal(t.level(null).find((i) => i.id === "f-db")?.count, 4);
		assert.equal(t.level(null).find((i) => i.id === "s1")?.count, 1);
	});

	it("folder counts use allSourceNodes when present (members before the search filter)", () => {
		const allSourceNodes = new Map([["s3", new Set(["x", "y"])], ["s4", new Set(["y", "z"])]]);
		assert.deepEqual(tree({ allSourceNodes }).folderNodeIds("f-pg").sort(), ["x", "y", "z"]);
	});

	it("parentOf and isInFolder follow the placements at any depth", () => {
		const t = tree();
		assert.equal(t.parentOf({ birth: "s3" }), "f-pg");
		assert.equal(t.parentOf({ birth: "s1" }), null);
		assert.equal(t.parentOf({ birth: null }), null);
		assert.equal(t.isInFolder({ birth: "s3" }, "f-db"), true);
		assert.equal(t.isInFolder({ birth: "s2" }, "f-pg"), false);
	});

	it("without a search every folder shows; hasChildren sees sources and child folders", () => {
		const t = tree();
		assert.equal(t.isFolderVisible("f-empty"), true);
		assert.equal(t.hasChildren("f-db"), true);
		assert.equal(t.hasChildren("f-empty"), false);
	});

	it("during a search a folder shows for a source below it, its own name, or a visible child folder", () => {
		// Only the source s3 passed the search filter.
		const searched = tree({ groups: [groups[2]!], query: "mvcc" });
		assert.deepEqual(searched.level(null).map((i) => i.id), ["f-db"]);
		assert.deepEqual(searched.level("f-db").map((i) => i.id), ["f-pg"]);
		const byName = tree({ groups: [], query: "postgr" });
		assert.equal(byName.isFolderVisible("f-pg"), true);
		assert.equal(byName.isFolderVisible("f-db"), true);
		assert.equal(byName.isFolderVisible("f-alg"), false);
		assert.equal(byName.hasChildren("f-db"), true);
	});

	it("a folder cycle in a bad organization file does not hang", () => {
		const loop: SourceOrganization = {
			version: 1,
			folders: [
				{ id: "x", name: "X", parentId: "y", createdAt: "" },
				{ id: "y", name: "Y", parentId: "x", createdAt: "" },
			],
			placements: { s1: { folderId: "x" } },
		};
		const t = folderTree({ groups: [] as FolderTreeSource[], organization: loop, query: "nothing", sort: { col: "name", dir: 1 } });
		assert.equal(t.isInFolder({ birth: "s1" }, "missing"), false);
		assert.equal(t.isFolderVisible("x"), false);
	});

	it("the module has no node:, React or DOM import (the phone imports it)", () => {
		const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/core/folder-order.ts");
		const imports = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("import"));
		assert.ok(imports.length > 0);
		for (const line of imports) assert.match(line, /from "\.\/[a-z-]+\.ts";$/);
	});
});
