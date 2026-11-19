/**
 * The pure graph view code moved to src/core (issue 08 of the mobile app):
 * src/core/graph-view-model.ts and src/core/graph-canvas-geometry.ts. The
 * phone imports these files directly. This test pins that the component
 * files re-export the same functions (one code for both apps), and that the
 * core files load with no DOM.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as geometry from "../src/core/graph-canvas-geometry.ts";
import * as viewModel from "../src/core/graph-view-model.ts";
import * as canvas from "../components/graph-canvas.ts";
import * as view from "../components/graph-view.tsx";

describe("graph view model in src/core", () => {
	it("the components re-export the core functions", () => {
		assert.equal(view.isNodeVisible, viewModel.isNodeVisible);
		assert.equal(view.seedMissingNodePositions, viewModel.seedMissingNodePositions);
		assert.equal(view.displayCostTotals, viewModel.displayCostTotals);
		for (const name of ["arrowGeometry", "fitTransform", "isImpNodeId", "labelAlpha", "pickNearest", "zoomRatioOf"] as const) {
			assert.equal(canvas[name], geometry[name], name);
		}
		assert.equal(canvas.CLUSTER_LIGHTNESS, geometry.CLUSTER_LIGHTNESS);
		assert.equal(canvas.LABELS_FADE_RATIO, geometry.LABELS_FADE_RATIO);
	});

	it("the seed keeps known positions and places the missing nodes off the centroid", () => {
		const positions = new Map([["a", { x: 0, y: 0 }], ["b", { x: 100, y: 0 }]]);
		const seeded = viewModel.seedMissingNodePositions([{ id: "a" }, { id: "b" }, { id: "c" }], positions);
		assert.deepEqual(seeded.get("a"), { x: 0, y: 0 });
		const c = seeded.get("c")!;
		assert.ok(Math.hypot(c.x - 50, c.y) > 70, "the seed is on the ring, not at the centroid");
	});

	it("the region lightness has one value for each rendered mode", () => {
		assert.deepEqual(geometry.CLUSTER_LIGHTNESS, { dark: { ring: 60, label: 78 }, light: { ring: 42, label: 30 } });
	});
});
