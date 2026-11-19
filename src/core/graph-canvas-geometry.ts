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

// ─── Shared draw constants (moved from components/graph-canvas.ts) ──────────
//
// The desktop renderer and the phone canvas draw with these numbers, so a
// change here changes both looks. Sizes are WORLD units unless they say
// "screen px".

/** The reference label size the wrap-width ratio is taken against. */
export const LABEL_SIZE = 12;
export const LABEL_WEIGHT = "500";
/** The node label wrap width at the reference label size, world units. */
export const LABEL_MAX_WIDTH = 170;
/** World units between the node edge and the first label line. */
export const LABEL_GAP = 2.9;
export const LABEL_LINE_HEIGHT = 1.3;

/** Region (cluster) labels wrap at a screen-fixed width, capped at a line
 *  count with an ellipsis on the last line (owner, 2026-09-23). */
export const REGION_LABEL_MAX_WIDTH = 220; // screen px
export const REGION_LABEL_MAX_LINES = 3;
export const REGION_LABEL_LINE_HEIGHT = 1.3;

/** Halo outer radius = node radius x this. */
export const GLOW_SCALE = 1.7;
/** Halo opacity at the disc edge, fading outward. */
export const GLOW_ALPHA = 0.3;
/** Extra pickable radius (screen px) beyond the disc. */
export const PICKING_PAD = 10;
/** Click vs drag threshold: pointer travel under this many px is a click. */
export const CLICK_SLOP = 4;
/** The padding (screen px) of the fit-to-view camera. */
export const FIT_PADDING = 40;
/** The camera scale limits (the desktop d3-zoom scaleExtent). */
export const ZOOM_EXTENT: readonly [number, number] = [0.02, 40];

/** Stable hue per cluster id (content-hash): the region keeps its color
 *  across reshuffles because the id only changes when the members do. */
export function clusterHue(id: string): number {
	let h = 0;
	for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
	return h;
}

// ─── Labels ─────────────────────────────────────────────────────────────────

/** The node label wrap width (world units) for a label size. */
export function labelWrapWidth(labelSize: number): number {
	return LABEL_MAX_WIDTH * (labelSize / LABEL_SIZE);
}

/** Word-wrap for node labels. Never truncates: overlong single words are
 *  hard-broken by character so no line ever exceeds maxWidth. `measure`
 *  is the canvas text measure (or a fake in tests). */
export function wrapLabel(text: string, maxWidth: number, measure: (s: string) => number): string[] {
	const lines: string[] = [];
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const last = lines.length > 0 ? lines[lines.length - 1]! : null;
		if (last !== null) {
			const joined = `${last} ${word}`;
			if (measure(joined) <= maxWidth) {
				lines[lines.length - 1] = joined;
				continue;
			}
		}
		let chunk = "";
		for (const char of word) {
			if (chunk && measure(`${chunk}${char}`) > maxWidth) {
				lines.push(chunk);
				chunk = char;
			} else {
				chunk += char;
			}
		}
		if (chunk) lines.push(chunk);
	}
	return lines;
}

/** Wrap one region label: word-wise first (session names), then
 *  char-wise for words alone wider than the max (long file paths — the
 *  node-label discipline), capped at maxLines. Overflow folds into the
 *  last line, ellipsized to fit. measure is the canvas measureText (or a
 *  fake in tests) — pure otherwise. */
export function wrapRegionLabel(
	text: string,
	maxWidth: number,
	maxLines: number,
	measure: (s: string) => number,
): string[] {
	if (maxLines < 1) return [text];
	if (measure(text) <= maxWidth) return [text];
	const lines: string[] = [];
	const pending: string[] = text.split(/\s+/).filter(Boolean);
	// Fill up to maxLines-1 lines; the remainder becomes the last line.
	while (pending.length > 0 && lines.length < maxLines - 1) {
		let line = "";
		while (pending.length > 0) {
			let word = pending[0]!;
			const candidate = line ? `${line} ${word}` : word;
			if (measure(candidate) <= maxWidth) {
				line = candidate;
				pending.shift();
				continue;
			}
			if (!line) {
				// The word alone overflows: char-split it, the remainder stays
				// pending for the next line (paths have no spaces to help).
				let chunk = "";
				while (word.length > 0 && measure(chunk + word[0]) <= maxWidth) {
					chunk += word[0];
					word = word.slice(1);
				}
				if (chunk) {
					lines.push(chunk);
					pending[0] = word;
				} else {
					// Degenerate: one char exceeds the width — keep it whole so
					// the label can never vanish entirely.
					lines.push(word);
					pending.shift();
				}
				line = "";
			}
			break;
		}
		if (line) lines.push(line);
		if (!line && lines.length > 0 && pending.length > 0) continue;
		if (!line && lines.length === 0) break;
	}
	// The remainder rides as the last line: plain if it fits, ellipsized
	// down to the width if not.
	const rest = pending.join(" ");
	if (!rest) return lines;
	if (measure(rest) <= maxWidth) {
		lines.push(rest);
		return lines;
	}
	let tail = rest;
	while (tail.length > 1 && measure(`${tail}…`) > maxWidth) tail = tail.slice(0, -1);
	lines.push(`${tail}…`);
	return lines;
}

// ─── Edges ──────────────────────────────────────────────────────────────────

/** All edge glyphs of one geometry build, as flat number lists (cheap to
 *  turn into one Path2D or one Skia path). */
export interface EdgeGlyphs {
	/** Shaft segments: x1, y1, x2, y2 for each edge. */
	shafts: number[];
	/** Head triangles: tip x, y, left x, y, right x, y for each head. */
	heads: number[];
}

/**
 * The shafts and arrowheads (rendering arc, owner 2026-09-30): all arrows
 * are PLAIN single shafts. Lines INTO an implication node are HEADLESS and
 * run to the imp node's CENTER (co-premise lines converge to a point); the
 * line OUT of it starts at the center and its arrowhead lands on the
 * conclusion's disc edge. Edges with a hidden or unknown end are skipped.
 */
export function edgeGlyphs(
	edges: ReadonlyArray<{ from: string; to: string }>,
	nodeById: ReadonlyMap<string, Pt>,
	isVisible: (id: string) => boolean,
	nodeR: number,
	arrowLength: number,
): EdgeGlyphs {
	const shafts: number[] = [];
	const heads: number[] = [];
	for (const e of edges) {
		if (!isVisible(e.from) || !isVisible(e.to)) continue;
		const a = nodeById.get(e.from);
		const b = nodeById.get(e.to);
		if (!a || !b) continue;
		const intoImp = isImpNodeId(e.to);
		const outOfImp = isImpNodeId(e.from);
		const g = arrowGeometry(a, b, outOfImp ? 0 : nodeR, intoImp ? 0 : nodeR, arrowLength);
		if (!g) continue;
		if (intoImp) {
			// toRadius 0 put the tip AT the imp node's center: the headless
			// shaft terminates there (no head triangle).
			shafts.push(g.shaftFrom.x, g.shaftFrom.y, g.tip.x, g.tip.y);
		} else {
			shafts.push(g.shaftFrom.x, g.shaftFrom.y, g.shaftTo.x, g.shaftTo.y);
			heads.push(g.tip.x, g.tip.y, g.left.x, g.left.y, g.right.x, g.right.y);
		}
	}
	return { shafts, heads };
}

// ─── Regions ────────────────────────────────────────────────────────────────

/** One region label anchor: the centroid of the visible members. */
export interface RegionAnchor {
	id: string;
	label: string | null;
	cx: number;
	cy: number;
	hue: number;
}

/** The region label anchors, in cluster order. A cluster with no visible
 *  member has no anchor. */
export function regionAnchors(
	clusters: ReadonlyArray<{ id: string; label: string | null; members: ReadonlyArray<string> }>,
	nodeById: ReadonlyMap<string, Pt>,
	isVisible: (id: string) => boolean,
): RegionAnchor[] {
	const anchors: RegionAnchor[] = [];
	for (const cluster of clusters) {
		let members = 0;
		let sumX = 0;
		let sumY = 0;
		for (const id of cluster.members) {
			if (!isVisible(id)) continue;
			const n = nodeById.get(id);
			if (!n) continue;
			members++;
			sumX += n.x;
			sumY += n.y;
		}
		if (members > 0)
			anchors.push({
				id: cluster.id,
				label: cluster.label || null,
				cx: sumX / members,
				cy: sumY / members,
				hue: clusterHue(cluster.id),
			});
	}
	return anchors;
}

/** One cluster's paint in the region bitmap, in bitmap px. */
export interface RegionLayer {
	hue: number;
	/** Intra-cluster edge strokes (round caps): x1, y1, x2, y2 each. */
	segments: number[];
	/** Discs for members that no stroke reached: x, y each. */
	discs: number[];
}

/** The region splat bitmap: what to paint, and where to draw it. */
export interface RegionSplat {
	/** The world rect that the bitmap covers. */
	rect: { minX: number; minY: number; w: number; h: number };
	/** World units per bitmap px. */
	cell: number;
	/** The bitmap size, px. */
	width: number;
	height: number;
	/** The stroke width and the disc radius, bitmap px. */
	lineWidth: number;
	discR: number;
	/** The box-blur radius, bitmap px (3 rounds, then x edgeAlpha). */
	blurPx: number;
	layers: RegionLayer[];
}

/**
 * The region splat plan (the density-field technique): every intra-cluster
 * edge paints a round-cap stroke (dilation) and every member that no
 * stroke reached paints one disc of the same radius, at full opacity. The
 * caller blurs the bitmap and scales its alpha by `edgeAlpha` once. Null
 * when no cluster has a visible member. Pure: the desktop paints it on a
 * Canvas 2D, the phone on a Skia surface.
 */
export function regionSplat(
	clusters: ReadonlyArray<{ id: string; members: ReadonlyArray<string> }>,
	edges: ReadonlyArray<{ from: string; to: string }>,
	nodeById: ReadonlyMap<string, Pt>,
	isVisible: (id: string) => boolean,
	tuning: { dilation: number; blur: number; bitmap: number },
): RegionSplat | null {
	// World rect over VISIBLE cluster members.
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const c of clusters) {
		for (const id of c.members) {
			if (!isVisible(id)) continue;
			const n = nodeById.get(id);
			if (!n) continue;
			if (n.x < minX) minX = n.x;
			if (n.x > maxX) maxX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.y > maxY) maxY = n.y;
		}
	}
	if (minX > maxX) return null;

	const clusterOf = new Map<string, number>();
	clusters.forEach((c, i) => {
		for (const id of c.members) clusterOf.set(id, i);
	});

	// Bitmap sizing: the longest world span maps to `bitmap` px. The rect
	// is padded by the stroke half-width plus the blur reach so nothing
	// clips. Cell floor: a single visible node (span 0) must not zero the
	// cell (the dims would blow to Infinity).
	const dilationW = tuning.dilation;
	const blurW = tuning.blur;
	const padWorld = dilationW + blurW * 2;
	const spanNow = Math.max(maxX - minX, maxY - minY);
	const cell = Math.max(spanNow, padWorld * 2) / tuning.bitmap;
	minX -= padWorld;
	minY -= padWorld;
	maxX += padWorld;
	maxY += padWorld;
	const spanX = maxX - minX;
	const spanY = maxY - minY;

	const layers: RegionLayer[] = [];
	clusters.forEach((cluster, ci) => {
		const segments: number[] = [];
		const touched = new Set<string>();
		for (const e of edges) {
			if (clusterOf.get(e.from) !== ci) continue;
			if (clusterOf.get(e.to) !== ci) continue;
			// Search filter: stroke only fully-visible edges (a hidden end
			// cut hue streaks across other regions, 2026-09-14).
			if (!isVisible(e.from) || !isVisible(e.to)) continue;
			const a = nodeById.get(e.from);
			const b = nodeById.get(e.to);
			if (!a || !b) continue;
			segments.push((a.x - minX) / cell, (a.y - minY) / cell, (b.x - minX) / cell, (b.y - minY) / cell);
			touched.add(e.from);
			touched.add(e.to);
		}
		const discs: number[] = [];
		for (const id of cluster.members) {
			if (touched.has(id) || !isVisible(id)) continue;
			const n = nodeById.get(id);
			if (!n) continue;
			discs.push((n.x - minX) / cell, (n.y - minY) / cell);
		}
		layers.push({ hue: clusterHue(cluster.id), segments, discs });
	});

	return {
		rect: { minX, minY, w: spanX, h: spanY },
		cell,
		width: Math.max(1, Math.ceil(spanX / cell)),
		height: Math.max(1, Math.ceil(spanY / cell)),
		lineWidth: (dilationW * 2) / cell,
		discR: dilationW / cell,
		blurPx: tuning.blur > 0 ? Math.max(1, Math.round(blurW / cell)) : 0,
		layers,
	};
}

/** One horizontal+vertical box-blur round over PREMULTIPLIED RGBA
 *  (Float32, stride 4, length w*h*4). Premultiplying first is what keeps
 *  the blur halo-free: blurring non-premultiplied RGB over varying alpha
 *  bleeds solid color into transparent space. Pure: DOM-free, tested. */
export function boxBlurRound(
	src: Float32Array,
	tmp: Float32Array,
	dst: Float32Array,
	w: number,
	h: number,
	radius: number,
): void {
	if (radius <= 0) {
		dst.set(src);
		return;
	}
	const div = radius * 2 + 1;
	// Horizontal: src → tmp (clamped window, running sum).
	for (let y = 0; y < h; y++) {
		const row = y * w * 4;
		let sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
		for (let x = -radius; x <= radius; x++) {
			const i = row + Math.min(Math.max(x, 0), w - 1) * 4;
			sum0 += src[i]!;
			sum1 += src[i + 1]!;
			sum2 += src[i + 2]!;
			sum3 += src[i + 3]!;
		}
		for (let x = 0; x < w; x++) {
			const o = row + x * 4;
			tmp[o] = sum0 / div;
			tmp[o + 1] = sum1 / div;
			tmp[o + 2] = sum2 / div;
			tmp[o + 3] = sum3 / div;
			const addI = row + Math.min(x + radius + 1, w - 1) * 4;
			const subI = row + Math.max(x - radius, 0) * 4;
			sum0 += src[addI]! - src[subI]!;
			sum1 += src[addI + 1]! - src[subI + 1]!;
			sum2 += src[addI + 2]! - src[subI + 2]!;
			sum3 += src[addI + 3]! - src[subI + 3]!;
		}
	}
	// Vertical: tmp → dst.
	for (let x = 0; x < w; x++) {
		const col = x * 4;
		let sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
		for (let y = -radius; y <= radius; y++) {
			const i = col + Math.min(Math.max(y, 0), h - 1) * w * 4;
			sum0 += tmp[i]!;
			sum1 += tmp[i + 1]!;
			sum2 += tmp[i + 2]!;
			sum3 += tmp[i + 3]!;
		}
		for (let y = 0; y < h; y++) {
			const o = col + y * w * 4;
			dst[o] = sum0 / div;
			dst[o + 1] = sum1 / div;
			dst[o + 2] = sum2 / div;
			dst[o + 3] = sum3 / div;
			const addI = col + Math.min(y + radius + 1, h - 1) * w * 4;
			const subI = col + Math.max(y - radius, 0) * w * 4;
			sum0 += tmp[addI]! - tmp[subI]!;
			sum1 += tmp[addI + 1]! - tmp[subI + 1]!;
			sum2 += tmp[addI + 2]! - tmp[subI + 2]!;
			sum3 += tmp[addI + 3]! - tmp[subI + 3]!;
		}
	}
}

/**
 * The region blur and alpha on RGBA pixels (in place): premultiply, three
 * box-blur rounds, unpremultiply, then scale the alpha by `edgeAlpha` once
 * (the order is a user decision, 2026-09-14). The result: a constant
 * interior alpha where covered, tapering only across the blur edges.
 */
export function blurRegionPixels(
	data: Uint8ClampedArray | Uint8Array,
	w: number,
	h: number,
	blurPx: number,
	edgeAlpha: number,
): void {
	const n = w * h * 4;
	const a = new Float32Array(n);
	for (let i = 0; i < n; i += 4) {
		const alpha = data[i + 3]! / 255;
		a[i] = data[i]! * alpha;
		a[i + 1] = data[i + 1]! * alpha;
		a[i + 2] = data[i + 2]! * alpha;
		a[i + 3] = data[i + 3]!;
	}
	const b = new Float32Array(n);
	const tmp = new Float32Array(n); // scratch inside each round only
	boxBlurRound(a, tmp, b, w, h, blurPx); // a → b
	boxBlurRound(b, tmp, a, w, h, blurPx); // b → a
	boxBlurRound(a, tmp, b, w, h, blurPx); // a → b (result)
	for (let i = 0; i < n; i += 4) {
		const alpha = b[i + 3]!;
		if (alpha <= 0) {
			data[i] = 0;
			data[i + 1] = 0;
			data[i + 2] = 0;
			data[i + 3] = 0;
		} else {
			// Un-premultiply: pm = c * a/255, so c = pm / a * 255.
			data[i] = Math.round((b[i]! / alpha) * 255);
			data[i + 1] = Math.round((b[i + 1]! / alpha) * 255);
			data[i + 2] = Math.round((b[i + 2]! / alpha) * 255);
			data[i + 3] = Math.round(alpha * edgeAlpha);
		}
	}
}
