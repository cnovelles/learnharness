/**
 * The shared canvas draw helpers in src/core/graph-canvas-geometry.ts. The
 * desktop renderer (components/graph-canvas.ts) and the phone canvas use
 * them, so these tests pin the numbers that both draw.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as renderer from "../components/graph-canvas.ts";
import { clusterHue as componentsHue } from "../components/cluster-geometry.ts";
import {
	FIT_PADDING,
	LABEL_MAX_WIDTH,
	ZOOM_EXTENT,
	arrowGeometry,
	blurRegionPixels,
	boxBlurRound,
	clusterHue,
	edgeGlyphs,
	labelWrapWidth,
	regionAnchors,
	regionSplat,
	wrapLabel,
	wrapRegionLabel,
} from "../src/core/graph-canvas-geometry.ts";

const measure = (s: string) => s.length * 5;
const visibleAll = () => true;

describe("the old import paths keep working", () => {
	it("components/graph-canvas.ts re-exports the core helpers", () => {
		assert.equal(renderer.wrapRegionLabel, wrapRegionLabel);
		assert.equal(renderer.boxBlurRound, boxBlurRound);
		assert.equal(renderer.arrowGeometry, arrowGeometry);
	});
	it("components/cluster-geometry.ts re-exports clusterHue", () => {
		assert.equal(componentsHue, clusterHue);
		assert.equal(clusterHue("c1"), clusterHue("c1"));
		assert.ok(clusterHue("abc") >= 0 && clusterHue("abc") < 360);
	});
	it("the camera constants are the desktop values", () => {
		assert.equal(FIT_PADDING, 40);
		assert.deepEqual(ZOOM_EXTENT, [0.02, 40]);
	});
});

describe("wrapLabel (node labels)", () => {
	it("joins words while they fit", () => {
		assert.deepEqual(wrapLabel("ab cd ef", 25, measure), ["ab cd", "ef"]);
	});
	it("hard-breaks a word wider than the line, never truncates", () => {
		assert.deepEqual(wrapLabel("abcdefgh", 15, measure), ["abc", "def", "gh"]);
	});
	it("an empty name has no line", () => {
		assert.deepEqual(wrapLabel("  ", 50, measure), []);
	});
	it("the wrap width grows with the label size", () => {
		assert.equal(labelWrapWidth(12), LABEL_MAX_WIDTH);
		assert.equal(labelWrapWidth(3), LABEL_MAX_WIDTH / 4);
	});
});

describe("edgeGlyphs (shafts and heads)", () => {
	const nodes = new Map([
		["a", { x: 0, y: 0 }],
		["b", { x: 10, y: 0 }],
		["arg_1", { x: 5, y: 5 }],
	]);
	it("a plain edge has a shaft clear of both discs and one head", () => {
		const g = edgeGlyphs([{ from: "a", to: "b" }], nodes, visibleAll, 1, 2);
		assert.deepEqual(g.shafts, [1, 0, 7, 0]);
		assert.equal(g.heads.length, 6);
		assert.deepEqual(g.heads.slice(0, 2), [9, 0]);
	});
	it("a line into an implication node is headless and ends at its center", () => {
		const g = edgeGlyphs([{ from: "a", to: "arg_1" }], nodes, visibleAll, 1, 2);
		assert.equal(g.heads.length, 0);
		assert.deepEqual(g.shafts.slice(2), [5, 5]);
	});
	it("a line out of an implication node starts at its center", () => {
		const g = edgeGlyphs([{ from: "arg_1", to: "b" }], nodes, visibleAll, 1, 2);
		assert.deepEqual(g.shafts.slice(0, 2), [5, 5]);
		assert.equal(g.heads.length, 6);
	});
	it("skips hidden ends, unknown ends and coincident ends", () => {
		const twin = new Map([...nodes, ["c", { x: 0, y: 0 }]]);
		const g = edgeGlyphs(
			[
				{ from: "a", to: "b" },
				{ from: "a", to: "zz" },
				{ from: "a", to: "c" },
			],
			twin,
			(id) => id !== "b",
			1,
			2,
		);
		assert.deepEqual(g, { shafts: [], heads: [] });
	});
});

describe("regionAnchors and regionSplat", () => {
	const nodes = new Map([
		["a", { x: 0, y: 0 }],
		["b", { x: 100, y: 0 }],
		["c", { x: 50, y: 100 }],
		["d", { x: 200, y: 200 }],
	]);
	const clusters = [
		{ id: "k1", label: "Plato", members: ["a", "b", "c"] },
		{ id: "k2", label: "", members: ["d"] },
		{ id: "k3", label: "Gone", members: ["zz"] },
	];
	const edges = [
		{ from: "a", to: "b" },
		{ from: "b", to: "d" },
	];
	const tuning = { dilation: 20, blur: 40, bitmap: 256 };

	it("anchors sit on the centroid of the visible members", () => {
		const anchors = regionAnchors(clusters, nodes, visibleAll);
		assert.deepEqual(
			anchors.map((a) => [a.id, a.label, a.cx, a.cy]),
			[
				["k1", "Plato", 50, 100 / 3],
				["k2", null, 200, 200],
			],
		);
		assert.equal(anchors[0]!.hue, clusterHue("k1"));
		const filtered = regionAnchors(clusters, nodes, (id) => id !== "c");
		assert.deepEqual([filtered[0]!.cx, filtered[0]!.cy], [50, 0]);
	});

	it("the bitmap covers the members, padded by dilation and blur reach", () => {
		const plan = regionSplat(clusters, edges, nodes, visibleAll, tuning)!;
		const pad = 20 + 40 * 2;
		assert.deepEqual(plan.rect, { minX: -pad, minY: -pad, w: 200 + 2 * pad, h: 200 + 2 * pad });
		assert.equal(plan.cell, 200 / 256);
		assert.equal(plan.width, Math.ceil(plan.rect.w / plan.cell));
		assert.equal(plan.lineWidth, 40 / plan.cell);
		assert.equal(plan.discR, 20 / plan.cell);
		assert.equal(plan.blurPx, Math.round(40 / plan.cell));
	});

	it("strokes intra-cluster edges and gives one disc to each member no stroke reached", () => {
		const plan = regionSplat(clusters, edges, nodes, visibleAll, tuning)!;
		const [k1, k2] = plan.layers;
		// a-b is inside k1; b-d crosses clusters and paints nothing.
		assert.equal(k1!.segments.length, 4);
		assert.equal(k1!.discs.length, 2); // c only
		assert.equal(k2!.segments.length, 0);
		assert.equal(k2!.discs.length, 2); // d
		assert.equal(k1!.hue, clusterHue("k1"));
	});

	it("a single visible node keeps a finite bitmap (the cell floor)", () => {
		const plan = regionSplat(clusters, edges, nodes, (id) => id === "d", tuning)!;
		assert.ok(Number.isFinite(plan.width) && plan.width > 0);
		assert.equal(plan.cell, (2 * (20 + 80)) / 256);
	});

	it("no visible member: no plan; blur 0 gives radius 0", () => {
		assert.equal(regionSplat(clusters, edges, nodes, () => false, tuning), null);
		assert.equal(regionSplat(clusters, edges, nodes, visibleAll, { ...tuning, blur: 0 })!.blurPx, 0);
	});
});

describe("blurRegionPixels", () => {
	it("keeps the color, spreads the coverage and scales the alpha once", () => {
		const w = 5;
		const h = 5;
		const px = new Uint8ClampedArray(w * h * 4);
		for (let i = 0; i < w * h; i++) {
			px[i * 4] = 200;
			px[i * 4 + 1] = 100;
			px[i * 4 + 2] = 50;
			px[i * 4 + 3] = 255;
		}
		blurRegionPixels(px, w, h, 1, 0.2);
		// A full field stays the same color, at alpha 255 x 0.2.
		assert.deepEqual([...px.slice(48, 52)], [200, 100, 50, 51]);
	});
	it("an empty field stays empty", () => {
		const px = new Uint8ClampedArray(3 * 3 * 4);
		blurRegionPixels(px, 3, 3, 1, 0.2);
		assert.ok(px.every((v) => v === 0));
	});
});
