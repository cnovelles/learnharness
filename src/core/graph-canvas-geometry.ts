/**
 * THE GRAPH CANVAS GEOMETRY — the pure math of the graph canvas
 * (components/graph-canvas.ts). The desktop renderer and the phone canvas
 * share it, so both use the same label gate, fit, arrowheads, hit test and
 * region lightness. Pure and browser-safe: no DOM, no d3, no `node:`
 * import. The phone imports this file directly.
 */

import type { RenderedMode } from "./themes.ts";

/** A point in world or screen space. */
type Pt = { x: number; y: number };

/** Implication-node ids (the mint law: newGraphChainId in core/graph.ts).
 *  On the canvas an imp node is PURE GEOMETRY (owner, rendering arc
 *  2026-09-30): invisible — no disc, no label — and UNPICKABLE,
 *  excluded from every hit-test path. Exported for the test pin. */
export const isImpNodeId = (id: string): boolean => id.startsWith("arg_");

/** Cluster region + label lightness (HSL %), per rendered mode — the
 *  hues come from clusterHue, only the lightness follows the page. */
export interface ClusterLightness {
	ring: number;
	label: number;
}

/** Dark keeps the original 60% regions / 78% labels; light darkens both so
 *  the pastel regions and their labels read on the paper background. */
export const CLUSTER_LIGHTNESS: Record<RenderedMode, ClusterLightness> = {
	dark: { ring: 60, label: 78 },
	light: { ring: 42, label: 30 },
};

/** The node→cluster label cross-fade spans gate × this (camera-ratio
 *  units) — PROPORTIONAL since 2026-09-17. The old absolute span (0.5
 *  ratio) read as a 100% relative change at the old 0.5 gate but a bare
 *  12% sliver at the tuned 8x gate (ratio 4): "lower zoom levels naturally
 *  produce a longer transitionary period while higher ones are more
 *  abrupt" — the user's exact observation. Proportional keeps ONE
 *  transitionary feel at any gate; at the 8x default the handoff fades
 *  across a full stop (8x → 12x). */
export const LABELS_FADE_RATIO = 0.5;

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────────

/**
 * The sigma-compatible "camera ratio": 1 at fit zoom, SMALLER when zoomed
 * in (ratio = kFit / k). The persisted labelZoom setting is denominated in
 * these units, so the gate semantics survive the renderer swap unchanged.
 */
export function zoomRatioOf(kFit: number, k: number): number {
	return kFit / k;
}

/**
 * Node-label opacity at a given camera ratio: 1 at/below the labelZoom
 * threshold, fading to 0 across a span of labelZoom x LABELS_FADE_RATIO
 * (see there). Cluster labels use `1 - this` over the same span — the
 * two cross-fade and never coexist at full opacity.
 */
export function labelAlpha(
	ratio: number,
	labelZoom: number,
	span = labelZoom * LABELS_FADE_RATIO,
): number {
	return clamp01(1 - (ratio - labelZoom) / span);
}

/** The camera transform that frames `bbox` in a w×h viewport with padding. */
export function fitTransform(
	bbox: { minX: number; maxX: number; minY: number; maxY: number },
	w: number,
	h: number,
	padding: number,
): { x: number; y: number; k: number } {
	const bw = Math.max(bbox.maxX - bbox.minX, 1e-6);
	const bh = Math.max(bbox.maxY - bbox.minY, 1e-6);
	const k = Math.min((w - 2 * padding) / bw, (h - 2 * padding) / bh);
	const cx = (bbox.minX + bbox.maxX) / 2;
	const cy = (bbox.minY + bbox.maxY) / 2;
	return { x: w / 2 - cx * k, y: h / 2 - cy * k, k };
}

/** The arrowhead geometry for a directed edge a→b: shaft endpoints
 *  (clear of both node discs) and the head triangle (tip on the target
 *  disc edge, wideness = 0.8 × head length — the sigma arrow shape). */
/** One complete arrow glyph: shaft + head triangle. */
export interface ArrowGeom {
	shaftFrom: Pt;
	shaftTo: Pt;
	tip: Pt;
	left: Pt;
	right: Pt;
}

export function arrowGeometry(
	a: Pt,
	b: Pt,
	fromRadius: number,
	toRadius: number,
	headLength: number,
): ArrowGeom | null {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	if (len < 1e-6) return null; // degenerate (coincident) — skip
	const ux = dx / len;
	const uy = dy / len;
	const tip = { x: b.x - ux * toRadius, y: b.y - uy * toRadius };
	const base = { x: tip.x - ux * headLength, y: tip.y - uy * headLength };
	const halfW = 0.4 * headLength;
	return {
		shaftFrom: { x: a.x + ux * fromRadius, y: a.y + uy * fromRadius },
		shaftTo: base,
		tip,
		left: { x: base.x - uy * halfW, y: base.y + ux * halfW },
		right: { x: base.x + uy * halfW, y: base.y - ux * halfW },
	};
}


/** Nearest node within maxDist of a screen point (linear scan — µs at
 *  our scale; a spatial grid only earns its keep past ~10k nodes). */
export function pickNearest<T extends { id: string; x: number; y: number }>(
	nodes: T[],
	px: number,
	py: number,
	maxDist: number,
): T | null {
	let best: T | null = null;
	let bestD = maxDist * maxDist; // compare squared distances
	for (const n of nodes) {
		const d = (n.x - px) ** 2 + (n.y - py) ** 2;
		if (d < bestD) {
			bestD = d;
			best = n;
		}
	}
	return best;
}
