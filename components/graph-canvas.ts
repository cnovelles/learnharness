"use client";

/**
 * The hand-rolled single-canvas graph renderer (decided 2026-09-13 after
 * the research pass — docs/research/graph-rendering.md, Option B).
 *
 * Replaces sigma.js. Why: sigma gave us WebGL node/edge rendering,
 * picking, and a camera, but our cluster regions had to live on foreign
 * canvases injected next to its private DOM stack, drawn from a separate
 * event loop — so hulls lagged behind nodes during pan, raced sigma's
 * canvas sizing on renderer rebuilds, and every camera event re-rasterized
 * the full hull canvas (GPU spikes + audible coil whine). At our scale
 * (338 → low thousands of nodes) one Canvas 2D is comfortably inside
 * 60fps territory, and a single loop makes the desync class of bugs
 * structurally impossible.
 *
 * Architecture (the canonical pattern — browser.engineering, MDN
 * "Optimizing canvas", web.dev canvas performance):
 *   - The renderer is a DUMB DRAW FUNCTION over plain data: nodes with
 *     world-space positions, edges, clusters, colors, settings. Layout
 *     (forceAtlas2) and filtering happen OUTSIDE, in the React component;
 *     this module never computes a position.
 *   - ONE canvas, ONE requestAnimationFrame loop with a dirty flag. Input
 *     and DOM events only mutate state and mark dirty; the loop draws at
 *     most once per frame with every layer under the same camera —
 *     hull fills → hull strokes → edges → nodes → region labels → node
 *     labels → hover. Nothing can ever lag anything else.
 *   - Camera: d3-zoom supplies the verified pan / zoom-to-cursor / pinch
 *     math (screen = world·k + [x,y]). The camera lives in the renderer
 *     instance, so data refetches and settings changes never move it.
 *   - Picking: nearest-node distance check (µs at our scale), with a
 *     PICKING_PAD so the whole hover halo is hit-testable.
 *
 * Zoom-gated labels (the Obsidian text-fade feel): sigma's camera "ratio"
 * convention is kept for the settings' persisted semantics — ratio 1 =
 * fit zoom, SMALLER = zoomed in (ratio = kFit / k). Node labels are
 * fully visible at ratio ≤ labelZoom and fade out across a span
 * proportional to the gate (LABELS_FADE_RATIO)
 * of ratio; cluster labels fade in over the exact same span (sums to 1)
 * so the two never coexist. All labels gate together — no per-node
 * popping.
 *
 * The hover glow is unchanged in look: a soft halo in the node's own
 * color at a constant radius, opacity cross-faded over ~180ms, with the
 * name brightening on the SAME factor. Only opacity animates; the only
 * per-frame work when idle is a dirty-flag check (no rAF is scheduled at
 * all until something changes).
 *
 * Unit tests cover the pure helpers (tests/graph-canvas.test.ts); the
 * class itself is DOM-bound and exercised live. Module scope stays
 * DOM-free so the file imports cleanly under Node.
 */

import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import type { Simulation, SimulationLinkDatum } from "d3-force";
import type { Pt } from "./cluster-geometry.ts";
import type { RenderedMode } from "@/src/core";
import {
	CHARGE_STRENGTH,
	CLUSTER_PULL_STRENGTH,
	createGraphSimulation,
	DEFAULT_PHYSICS_TUNING,
	DEFAULT_REGION_TUNING,
	sanitizePhysicsTuning,
	sanitizeRegionTuning,
	type PhysicsTuning,
	type RegionTuning,
	INCREMENTAL_GRAVITY,
	LINK_DISTANCE,
	type DepthAnchorMode,
	type GraphRenderSettings,
	type LayoutNode,
	type Position,
} from "@/src/core";

import {
	CLICK_SLOP,
	CLUSTER_LIGHTNESS,
	FIT_PADDING,
	GLOW_ALPHA,
	GLOW_SCALE,
	LABEL_GAP,
	LABEL_LINE_HEIGHT,
	LABEL_WEIGHT,
	LABELS_FADE_RATIO,
	PICKING_PAD,
	REGION_LABEL_LINE_HEIGHT,
	REGION_LABEL_MAX_LINES,
	REGION_LABEL_MAX_WIDTH,
	ZOOM_EXTENT,
	arrowGeometry,
	blurRegionPixels,
	boxBlurRound,
	edgeGlyphs,
	fitTransform,
	isImpNodeId,
	labelAlpha,
	labelWrapWidth,
	pickNearest,
	regionAnchors,
	regionSplat,
	wrapLabel,
	wrapRegionLabel,
	zoomRatioOf,
	type ArrowGeom,
	type ClusterLightness,
} from "@/src/core";

export type { GraphRenderSettings };
// The pure canvas math lives in src/core (the phone shares it); the old
// names stay importable from here.
export {
	CLUSTER_LIGHTNESS,
	LABELS_FADE_RATIO,
	arrowGeometry,
	boxBlurRound,
	fitTransform,
	isImpNodeId,
	labelAlpha,
	pickNearest,
	wrapRegionLabel,
	zoomRatioOf,
	type ArrowGeom,
	type ClusterLightness,
};

// ─── Public data contract ──────────────────────────────────────────────────

/** One node to draw: world-space position + the short glanceable label. */
export interface CanvasNode {
	id: string;
	x: number;
	y: number;
	label: string;
}

/** One directed edge of the DERIVED view (chains-primary, 2026-09-30):
 *  premise → implication node → conclusion, UNTYPED, all PLAIN
 *  single-shaft arrows — there is no double-shaft glyph anywhere
 *  (the 2026-09-14 ruling died with typed edges). An argument renders
 *  as its geometry: co-premise lines converge HEADLESS onto the
 *  implication point, one arrowed line leaves it; a single-premise
 *  argument is one ordinary arrow (see deriveView). */
export interface CanvasEdge {
	from: string;
	to: string;
}


/** One cluster region: member node ids + the LLM-coined label (or null). */
export interface CanvasCluster {
	id: string;
	label: string | null;
	members: string[];
}


/** Theme colors, resolved to #rrggbb by the caller (canvas wants hex,
 *  and the renderer must not read CSS itself). */
export interface CanvasColors {
	node: string;
	edge: string;
	label: string;
	hoverText: string;
	clusterLightness: ClusterLightness;
}

export interface CanvasData {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	/** The LOGICAL arrows (proposition→conclusion, imp contracted) the
	 *  depth force consumes — absent = the sim derives depth from the
	 *  drawn edges (legacy). Optional so non-graph callers of the
	 *  renderer stay simple. */
	logicalEdges?: CanvasEdge[];
	/** The imp chain linkage — the depth pass anchors each junction at
	 *  the premises/conclusion midpoint (owner, 2026-09-30). */
	impLinks?: ReadonlyArray<{ id: string; premises: ReadonlyArray<string>; conclusion: string }>;
	clusters: CanvasCluster[];
	colors: CanvasColors;
	/** Body font family (labels must match the app typography). */
	fontFamily: string;
}

export interface RendererCallbacks {
	/** A node was clicked (screen position included for card anchoring). */
	onSelect: (nodeId: string, screenPos: Pt) => void;
	/** Right-click: the picked node (canvas-relative screen position) or
	 *  null when the pointer hit empty stage — the caller opens/closes
	 *  its context menu accordingly. (node interlude, wave 7) */
	onContext: (nodeId: string | null, screenPos: Pt) => void;
	/** The empty stage was clicked. */
	onStageClick: () => void;
	/** Any camera move (pan/zoom) — the caller dismisses anchored UI and
	 *  persists the camera (view state). */
	onCameraMove: (transform: { k: number; x: number; y: number }) => void;
	/** The live sim settled after a drag: commit the new rest state
	 *  (the caller PUTs it to the positions ledger). */
	onCommit: (positions: Record<string, Position>) => void;
}

// ─── Constants (ported verbatim from the sigma view) ────────────────────────

/** Label-only cluster patch (rename-shuffle fix, 2026-09-23): apply a set
 *  of live label updates to the data-side cluster records AND the built
 *  region meta (re-wrapping the changed entries with the provided
 *  measure — the same wrap a geometry build would produce). The
 *  hull-silence guard travels here: a cluster whose CURRENT label is
 *  null is a gone record — no rename can reach it. Pure, in-place on the
 *  provided arrays; returns whether anything changed (the caller only
 *  redraws when it did). Exported for tests. */
export function applyClusterLabels(
	clusters: { id: string; label: string | null }[],
	regionMeta: { id: string; label: string | null; lines: string[] | null }[],
	labels: ReadonlyMap<string, string | null>,
	maxWidth: number,
	maxLines: number,
	measure: (s: string) => number,
): boolean {
	let changed = false;
	for (const cluster of clusters) {
		if (!labels.has(cluster.id)) continue;
		if (cluster.label == null) continue; // hull silence: gone records stay silent
		const label = labels.get(cluster.id) ?? null;
		if (label === cluster.label) continue;
		cluster.label = label;
		changed = true;
	}
	if (!changed) return false;
	for (const rm of regionMeta) {
		if (!labels.has(rm.id)) continue;
		if (rm.label == null) continue;
		const label = labels.get(rm.id) ?? null;
		rm.label = label;
		rm.lines = label
			? wrapRegionLabel(label, maxWidth, maxLines, measure)
			: null;
	}
	return true;
}
const HOVER_FADE_MS = 180; // hover halo opacity fade length
const ZOOM_EASE_MS = 45; // wheel-zoom glide: exponential-ease time constant (~250ms per notch)

/** Live-sim tuning — see the class doc comment. */
const LIVE_ALPHA_DECAY = 0.05; // snappier anneal than the settle's 0.0228
const DRAG_ALPHA_TARGET = 0.3; // d3-drag's own reheat constant
const SIM_SETTLE_ALPHA = 0.005; // below this, the sim counts as settled
const COMMIT_DEBOUNCE_MS = 250; // settle → ledger PUT delay (new drags cancel)

/** Cluster region styling — a low-res world-space SPLAT bitmap (the
 *  density-field technique, Canvas-2D edition): every member node paints
 *  a soft radial-gradient disc and every intra-cluster edge a round-cap
 *  stroke; upscaling the bitmap with bilinear smoothing IS the blur.
 *  Replaces the convex-hull fills + borders: concave cluster shapes are
 *  finally correct (the hull bridged every gap with straight lines —
 *  the jagged close-up look), there is no border to lag behind, and a
 *  live-physics frame pays one tiny blit instead of 32 clusters × 4
 *  offset polygons re-rasterized at DPR 2 (the old GPU coil-whine). */
const REGION_EVERY = 3; // live-sim frames: rebuild every Nth, blit the rest



/** Geometry constants are WORLD UNITS (the 2026-09-15 pivot): node/
 *  label/arrowhead sizes come from the settings directly — the same law
 *  as linkDistance — so the world scale is canonical and never depends on
 *  the graph's extent or the viewport. Camera zoom scales them with the
 *  graph (Obsidian-style); edge widths and hull borders stay
 *  viewer-relative hairlines (÷ k); cluster labels stay screen-fixed
 *  (px at any zoom). kFit survives ONLY as the label-gate's "1×"
 *  reference (zoomRatioOf) — a pure LOD threshold, no geometry reads it. */


// ─── Canvas text helpers (ported verbatim) ─────────────────────────────────

/** "#rrggbb" + alpha → "rgba(...)". */
function rgbaFromHex(hex: string, alpha: number): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** World-unit sizes for the label pass, derived once per geometry build. */
interface WorldSizes {
	nodeR: number; // node disc radius, world units
	glowOuter: number; // hover halo outer radius, world units
	labelSize: number; // node label font, world units
	labelGap: number; // node edge → first label line, world units
}

/** The pre-wrapped node name, centered below the node in WORLD units —
 *  identical geometry at rest and on hover, so hover only changes the
 *  color, nothing jumps. Lines are wrapped once per geometry build, never
 *  per frame. */
function drawNameLines(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	lines: string[],
	world: WorldSizes,
	color: string,
): void {
	context.fillStyle = color;
	context.textAlign = "center";
	context.textBaseline = "top";
	const firstTop = y + world.nodeR + world.labelGap;
	for (let i = 0; i < lines.length; i++) {
		context.fillText(lines[i]!, x, firstTop + i * world.labelSize * LABEL_LINE_HEIGHT);
	}
}

// ─── The renderer ───────────────────────────────────────────────────────────

export class GraphCanvasRenderer {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private callbacks: RendererCallbacks;
	private zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown>;
	private transform: ZoomTransform = zoomIdentity;
	/** Set once the first fit happens; the camera then survives setData. */
	private hasFit = false;
	/** Last-synced CSS size — the resize anchor computes the world point
	 *  under the PRE-resize viewport center from these (ResizeObserver
	 *  callbacks already see the NEW size in clientWidth/Height). */
	private viewW = 0;
	private viewH = 0;
	/** The k that frames the whole graph — the label-gate's "1×". */
	private kFit = 1;
	/** World-space bounds of the current nodes — fit() and the resize-time
	 *  kFit refresh share it (computed once per setData, not per resize). */
	private worldBBox: { minX: number; maxX: number; minY: number; maxY: number } | null = null;

	private data: CanvasData | null = null;
	/** id -> node for the current data (avoids O(n^2) scans). */
	private nodeById = new Map<string, CanvasNode>();
	private settings: GraphRenderSettings | null = null;
	private visible: ReadonlySet<string> | null = null;

	// ── Live physics ──
	// One d3-force sim shared with the server settle (createGraphSimulation
	// in @/src/core): dragging pins fx/fy and reheats (alphaTarget), release
	// un-pins and the sim anneals; once alpha drops below SIM_SETTLE_ALPHA
	// the new rest state is debounced-committed via onCommit. The sim mutates
	// data.nodes IN PLACE (they ARE the sim nodes — zero copying), so every
	// tick just bumps geoVersion and the draw loop rebuilds geometry.
	private sim: Simulation<LayoutNode, SimulationLinkDatum<LayoutNode>> | null = null;
	private simById = new Map<string, LayoutNode>();
	private simActive = false;
	private dragId: string | null = null;
	private dragOrigin: Pt | null = null;
	private simMoved = false; // any real movement since the last commit
	private commitTimer: ReturnType<typeof setTimeout> | null = null;

	private frameId: number | null = null;
	private dirty = true;
	/** True while tick() runs: markDirty inside the loop (d3's zoom event
	 *  fires from advanceZoom) must NOT schedule — the loop schedules
	 *  itself below. Un-guarded, each glide frame leaked an extra queued
	 *  tick and draws multiplied per displayed frame (20fps zoom bug). */
	private inTick = false;

	// Hover transition: fade 0 = resting, 1 = fully hovered; the animating
	// flag keeps the loop scheduled until the fade settles (then rAF stops).
	private hoverId: string | null = null;
	/** The node the glow is drawn on. OUTLIVES hoverId on hover-out so the
	 *  fade has something to draw (hoverId nulls instantly; without this
	 *  the glow popped off in one frame instead of fading). Cleared when
	 *  the outgoing fade completes. */
	private hoverNode: CanvasNode | null = null;
	private hoverFade = 0;
	private hoverFrom = 0;
	private hoverTarget = 0;
	private hoverStart = 0;
	// Smooth wheel zoom: wheel events accumulate a target scale (cursor-
	// anchored); each tick eases the camera toward it instead of jumping.
	private zoomTarget: { k: number; x: number; y: number } | null = null;
	/** Clock for frame-rate-independent easing (updated every tick). */
	private lastTickAt = 0;
	private animating = false;

	private resizeObserver: ResizeObserver;
	private downPos: Pt | null = null;

	// ── Cached world geometry ─────────────────────────────────────────────
	// Everything above is drawn per frame; everything below is derived from
	// data+visibility+settings+kFit and rebuilt ONLY when one of those
	// changes (geoVersion). Camera moves just re-rasterize the same paths.
	private geoVersion = 0; // bump = geometry inputs changed
	private builtVersion = -1; // version the cache was built at
	private nodesPath: Path2D | null = null;
	private shaftsPath: Path2D = new Path2D();
	private headsPath: Path2D = new Path2D();
	private regionCanvas: HTMLCanvasElement | null = null;
	/** World rect the bitmap covers (drawImage target coords). */
	private regionRect: { minX: number; minY: number; w: number; h: number } | null = null;
	/** Region labels: cluster centroid + hue, computed at splat build. */
	private regionMeta: { id: string; label: string | null; lines: string[] | null; cx: number; cy: number; hue: number }[] = [];
	private regionTuning: RegionTuning = DEFAULT_REGION_TUNING;
	private physicsTuning: PhysicsTuning = DEFAULT_PHYSICS_TUNING;
	/** Gravity center for the live sim (graph bbox centroid at setData). */
	private simCenter: Pt = { x: 0, y: 0 };
	private regionBuiltVersion = -1;
	private frameCount = 0; // draw counter for the live-sim splat throttle
	private labelLines = new Map<string, string[]>();
	private worldLabelFont = "";
	private world: WorldSizes = { nodeR: 0, glowOuter: 0, labelSize: 0, labelGap: 0 };

	constructor(
		canvas: HTMLCanvasElement,
		callbacks: RendererCallbacks,
		/** The caller's persisted camera (view state — localStorage): when
		 *  present it REPLACES the first-open fit; the graph opens exactly
		 *  where the user left it (2026-09-15: a default zoom exists only
		 *  on first open, ever). Invalid shapes fall back to fit. */
		initialCamera?: { k: number; x: number; y: number } | null,
	) {
		this.canvas = canvas;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("2d context unavailable");
		this.ctx = ctx;
		this.callbacks = callbacks;

		// d3-zoom owns pan / wheel zoom-to-cursor / touch pinch; every
		// transform change just marks dirty (draws happen in OUR loop).
		this.zoomBehavior = zoom<HTMLCanvasElement, unknown>()
			.scaleExtent([ZOOM_EXTENT[0], ZOOM_EXTENT[1]])
			.on("zoom", ({ transform }) => {
				this.transform = transform;
				this.markDirty();
				// The transform doubles as the persistence payload (view state).
				this.callbacks.onCameraMove(transform);
			});
		select(canvas)
			.call(this.zoomBehavior)
			// No surprise dblclick-zoom (sigma had none).
			.on("dblclick.zoom", null)
			// Wheel is OURS now: d3's instant per-notch jump felt janky; the
			// eased glide below replaces it (pan and pinch stay d3's).
			.on("wheel.zoom", null);

		canvas.addEventListener("wheel", this.onWheel, { passive: false });
		canvas.addEventListener("pointermove", this.onPointerMove);
		canvas.addEventListener("pointerdown", this.onPointerDown);
		canvas.addEventListener("pointerup", this.onPointerUp);
		canvas.addEventListener("pointerleave", this.onPointerLeave);
		// Right-click → the caller's context menu (node interlude). Always
		// preventDefault: the native menu on a full-bleed custom canvas is
		// never useful; the caller decides what (if anything) opens.
		canvas.addEventListener("contextmenu", this.onContextMenu);

		// The persisted camera: replace the default with wherever the user
		// left the graph. Applied through the zoom behavior so d3's internal
		// state and ours agree (the same path fit() uses); hasFit so neither
		// the ResizeObserver nor setData re-fits over it.
		if (
			initialCamera &&
			typeof initialCamera.k === "number" && Number.isFinite(initialCamera.k) && initialCamera.k > 0 &&
			typeof initialCamera.x === "number" && Number.isFinite(initialCamera.x) &&
			typeof initialCamera.y === "number" && Number.isFinite(initialCamera.y)
		) {
			this.hasFit = true;
			select(canvas).call(
				this.zoomBehavior.transform,
				zoomIdentity.translate(initialCamera.x, initialCamera.y).scale(initialCamera.k),
			);
		}

		this.resizeObserver = new ResizeObserver(() => {
			// The world point under the pre-resize viewport center — the
			// visual anchor the new transform must preserve. Capture it
			// BEFORE syncSize (which updates viewW/H to the new size).
			const prevW = this.viewW;
			const prevH = this.viewH;
			const { x: tx, y: ty, k } = this.transform;
			const wx = (prevW / 2 - tx) / k;
			const wy = (prevH / 2 - ty) / k;
			this.syncSize();
			if (!this.hasFit) this.fit(); // first real size → fit once
			else {
				this.refreshFitZoom(); // the gate's "1×" is viewport-bound
				// Center-anchor (2026-09-17, owner): same world point under
				// the NEW center. Applied through the zoom behavior like every
				// camera move (d3 state, persistence, card-dismiss all agree).
				if (prevW > 0 && prevH > 0 && this.viewW > 0 && this.viewH > 0) {
					select(canvas).call(
						this.zoomBehavior.transform,
						zoomIdentity.translate(this.viewW / 2 - wx * k, this.viewH / 2 - wy * k).scale(k),
					);
				}
			}
			// Redraw SYNCHRONOUSLY: syncSize may have reallocated the backing
			// store (which clears the canvas), and during live window resizes
			// rAF is starved by relayout — a deferred draw would leave the
			// canvas blank for the whole drag (the resize-blanking bug).
			this.draw();
		});
		this.resizeObserver.observe(canvas);
		this.syncSize();
	}

	// ── Public API ──

	setData(data: CanvasData): void {
		this.data = data;
		this.nodeById = new Map(data.nodes.map((n) => [n.id, n]));
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of data.nodes) {
			if (n.x < minX) minX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.x > maxX) maxX = n.x;
			if (n.y > maxY) maxY = n.y;
		}
		this.worldBBox = { minX, maxX, minY, maxY };
		if (!this.hasFit && data.nodes.length > 0) this.fit();
		// The camera may be user-restored (constructor initialCamera) — the
		// gate's "1×" reference still needs the fresh bbox's fit zoom.
		else this.refreshFitZoom();
		// Rebuild the live sim around the fresh nodes. New data means the
		// server spoke (merge or refetch); any pending commit is moot and
		// the graph is at rest until the next drag.
		if (this.commitTimer) {
			clearTimeout(this.commitTimer);
			this.commitTimer = null;
		}
		this.simActive = false;
		this.dragId = null;
		this.simMoved = false;
		this.simCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
		this.buildSim();
		this.geoVersion++; // new data → rebuild world geometry
		this.markDirty();
	}

	setSettings(settings: GraphRenderSettings): void {
		this.settings = settings;
		this.geoVersion++; // sizes/wrap width changed → rebuild geometry
		this.markDirty();
	}

	/** Dev tuning for region rendering (session-only, never persisted):
	 *  invalid numbers fall back to defaults — the number inputs can be
	 *  emptied while typing. Forces a region bitmap rebuild. */
	setRegionTuning(input: Partial<RegionTuning>): void {
		this.regionTuning = sanitizeRegionTuning(input);
		this.regionBuiltVersion = -2; // never equals geoVersion → rebuild
		// Off switch turning off: drop the bitmap immediately so the
		// blit stops on the next frame — the rebuild itself skips all
		// compute (buildRegions).
		if (!this.regionTuning.enabled) {
			this.regionCanvas = null;
			this.regionRect = null;
		}
		this.markDirty();
	}

	/** Live-sim physics controls: rebuilds the sim from the CURRENT
	 *  node positions (same node objects — x/y and any drag pin fx/fy
	 *  survive; velocities restart clean, which reads as "re-relax with
	 *  the new feel"). A mid-settle change re-anneals, which is the
	 *  honest response to new physics. */
	setPhysicsTuning(input: Partial<PhysicsTuning>): void {
		this.physicsTuning = sanitizePhysicsTuning(input);
		this.buildSim();
		// Reheat: a tuning change re-anneals the layout from its current
		// state, so mode toggles (off/vertical/radial) visibly RE-FORM the
		// graph instead of waiting for the next drag. Mid-drag is safe —
		// buildSim preserved the pinned node's fx/fy.
		if (this.sim) {
			this.sim.alpha(1);
			this.simActive = true;
		}
		this.markDirty();
	}

	/** Label-only channel (rename-shuffle fix, 2026-09-23): live
	 *  cluster-label updates with NO setData. The rename path used to
	 *  build a fresh snapshot object, which flowed setData → geometry
	 *  rebuild — and the rebuild treats the last-fetched ledger as
	 *  authoritative and cancels any pending drag commit, so a rename
	 *  visibly rewound the whole graph whenever display had drifted
	 *  (recent drag, mid-anneal, physics re-anneal). This channel touches
	 *  ONLY label text: the region meta the draw pass reads plus the
	 *  data-side cluster record (so the next geometry rebuild —
	 *  visibility/settings/size — keeps the fresh label). Nodes, the
	 *  sim, positions, and the pending commit are never touched. */
	setClusterLabels(labels: ReadonlyMap<string, string | null>): void {
		const data = this.data;
		if (!data) return;
		const settings = this.settings;
		// No settings yet → nothing is drawn; patch the data side only and
		// let the next build derive the wrap (same guard the build uses).
		if (!settings) {
			applyClusterLabels(data.clusters, [], labels, REGION_LABEL_MAX_WIDTH, REGION_LABEL_MAX_LINES, () => 0);
			return;
		}
		const ctx = this.ctx;
		const prevFont = ctx.font;
		ctx.font = `${LABEL_WEIGHT} ${settings.clusterLabelSize}px ${data.fontFamily}`;
		const changed = applyClusterLabels(
			data.clusters,
			this.regionMeta,
			labels,
			REGION_LABEL_MAX_WIDTH,
			REGION_LABEL_MAX_LINES,
			(s) => ctx.measureText(s).width,
		);
		ctx.font = prevFont;
		if (changed) this.markDirty();
	}

	setVisible(visible: ReadonlySet<string> | null): void {
		this.visible = visible;
		this.geoVersion++; // member visibility changes hulls + paths
		this.markDirty();
	}

	/** Frame the whole graph (padding included). Keeps the camera on later
	 *  setData calls — call fit() only for an explicit re-frame (the
	 *  first-ever open; afterwards the caller-persisted camera wins). */
	fit(): void {
		if (!this.data || this.data.nodes.length === 0 || !this.worldBBox) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w < 10 || h < 10) return; // layout not ready yet; the ResizeObserver retries
		const t = fitTransform(this.worldBBox, w, h, FIT_PADDING);
		this.kFit = t.k;
		this.hasFit = true;
		select(this.canvas).call(
			this.zoomBehavior.transform,
			zoomIdentity.translate(t.x, t.y).scale(t.k),
		);
	}

	/** Refresh the label-gate's "1×" reference from the current bbox +
	 *  viewport. kFit feeds ONLY zoomRatioOf now (the 2026-09-15 pivot
	 *  removed it from geometry) — so this never touches geoVersion. */
	private refreshFitZoom(): void {
		if (!this.worldBBox) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w >= 10 && h >= 10) this.kFit = fitTransform(this.worldBBox, w, h, FIT_PADDING).k;
	}

	destroy(): void {
		if (this.frameId !== null) cancelAnimationFrame(this.frameId);
		if (this.commitTimer) clearTimeout(this.commitTimer);
		this.sim = null;
		this.simActive = false;
		this.dragId = null;
		this.resizeObserver.disconnect();
		select(this.canvas).on(".zoom", null);
		this.canvas.removeEventListener("wheel", this.onWheel);
		this.canvas.removeEventListener("pointermove", this.onPointerMove);
		this.canvas.removeEventListener("pointerdown", this.onPointerDown);
		this.canvas.removeEventListener("pointerup", this.onPointerUp);
		this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
		this.canvas.removeEventListener("contextmenu", this.onContextMenu);
		this.canvas.style.cursor = "";
	}

	// ── Event handlers (state mutation only — never draw) ──

	/** Wheel: accumulate the zoom target; the camera GLIDES toward it in the
	 *  tick loop (cursor-anchored). Sensitivity formula is d3-zoom's own. */
	private onWheel = (e: WheelEvent) => {
		e.preventDefault();
		const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002);
		const { x, y } = this.eventPos(e);
		const current = this.zoomTarget?.k ?? this.transform.k;
		// Must stay inside the zoomBehavior's scaleExtent [0.02, 40].
		const k = Math.min(Math.max(current * Math.exp(delta), ZOOM_EXTENT[0]), ZOOM_EXTENT[1]);
		this.zoomTarget = { k, x, y };
		// Fresh easing clock so the glide starts gentle, never half-done.
		this.lastTickAt = performance.now();
		this.markDirty();
	};

	private onPointerMove = (e: PointerEvent) => {
		const pos = this.eventPos(e);
		if (this.dragId) {
			const n = this.simById.get(this.dragId);
			if (n) {
				const moved =
					this.dragOrigin !== null &&
					Math.hypot(pos.x - this.dragOrigin.x, pos.y - this.dragOrigin.y) > CLICK_SLOP;
				if (moved) {
					// First real movement: reheat and glue the node to the cursor.
					if (this.commitTimer) {
						clearTimeout(this.commitTimer);
						this.commitTimer = null;
					}
					this.sim?.alphaTarget(DRAG_ALPHA_TARGET);
					this.simActive = true;
					this.markDirty();
				}
				const { x: tx, y: ty, k } = this.transform;
				n.fx = (pos.x - tx) / k;
				n.fy = (pos.y - ty) / k;
			}
			return;
		}
		const node = this.pickAt(pos.x, pos.y);
		if ((node?.id ?? null) !== this.hoverId) this.setHover(node?.id ?? null);
		this.canvas.style.cursor = node ? "pointer" : "";
	};

	private onPointerDown = (e: PointerEvent) => {
		// Primary button only (owner, polish round): a right-press must not
		// pin the node — right-click belongs to the context menu alone, and
		// the right-pointerup must never read as a click (the detail card
		// used to open under the menu).
		if (e.button !== 0) return;
		const pos = this.eventPos(e);
		const node = this.pickAt(pos.x, pos.y);
		if (node && this.sim) {
			// Node press: pin the node (at ITS OWN position — the cursor
			// may be inside the pick pad, off-center). preventDefault kills
			// the compatibility mousedown, so d3-zoom never starts a pan.
			// Physics only reheats once the pointer exceeds CLICK_SLOP —
			// a plain click stays perfectly still.
			e.preventDefault();
			try {
				this.canvas.setPointerCapture(e.pointerId);
			} catch {
				/* capture is best-effort */
			}
			this.dragId = node.id;
			this.dragOrigin = pos;
			const n = this.simById.get(node.id);
			if (n) {
				n.fx = n.x;
				n.fy = n.y;
			}
			this.canvas.style.cursor = "grabbing";
			this.markDirty();
			return;
		}
		this.downPos = pos;
		this.zoomTarget = null; // a pan takes over — cancel any zoom glide
	};

	private onPointerUp = (e: PointerEvent) => {
		if (e.button !== 0) return; // right-click is context-menu territory
		// Node press ending: click (no slop) → select; drag → release-and-relax.
		if (this.dragId) {
			const id = this.dragId;
			this.dragId = null;
			this.dragOrigin = null;
			try {
				this.canvas.releasePointerCapture(e.pointerId);
			} catch {
				/* already released */
			}
			this.canvas.style.cursor = "";
			const n = this.simById.get(id);
			if (n) {
				n.fx = null;
				n.fy = null;
			}
			if (this.simActive) {
				// Real drag: the sim anneals to the new rest state; advanceSim
				// detects the settle and schedules the commit.
				this.sim?.alphaTarget(0);
				this.markDirty();
			} else {
				// Never heated: a plain click on the node.
				this.callbacks.onSelect(id, this.eventPos(e));
			}
			return;
		}
		if (!this.downPos) return;
		const pos = this.eventPos(e);
		const moved = Math.hypot(pos.x - this.downPos.x, pos.y - this.downPos.y);
		this.downPos = null;
		if (moved > CLICK_SLOP) return; // that was a drag (pan), not a click
		const node = this.pickAt(pos.x, pos.y);
		if (node) this.callbacks.onSelect(node.id, pos);
		else this.callbacks.onStageClick();
	};

	/** Right-click: pick the node under the pointer, hand the position to
	 *  the caller (empty stage = null — the caller closes any open menu). */
	private onContextMenu = (e: MouseEvent) => {
		e.preventDefault();
		const pos = this.eventPos(e);
		const node = this.pickAt(pos.x, pos.y);
		this.callbacks.onContext(node?.id ?? null, pos);
	};

	private onPointerLeave = () => {
		if (this.dragId) return; // pointer capture keeps the drag alive
		this.downPos = null;
		this.setHover(null);
	};

	// ── Internals ──

	private eventPos(e: { clientX: number; clientY: number }): Pt {
		const rect = this.canvas.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	private pickAt(px: number, py: number): CanvasNode | null {
		if (!this.data || !this.settings) return null;
		// Screen positions, filtered to visible nodes.
		const { x: tx, y: ty, k } = this.transform;
		// Discs scale with the camera now: their screen radius is
		// nodeSize × k/kFit; the halo pad stays a constant screen pad.
		// nodeSize is world units now (2026-09-15): the on-screen hit radius
		// is the disc's world radius × the camera zoom, plus the constant
		// screen pad — the whole halo stays hit-testable.
		const maxDist = this.settings.nodeSize * k + PICKING_PAD;
		const projected: { id: string; x: number; y: number }[] = [];
		for (const n of this.data.nodes) {
			if (this.visible && !this.visible.has(n.id)) continue;
			if (isImpNodeId(n.id)) continue; // pure geometry — never picked
			projected.push({ id: n.id, x: n.x * k + tx, y: n.y * k + ty });
		}
		const hit = pickNearest(projected, px, py, maxDist);
		if (!hit) return null;
		return this.nodeById.get(hit.id) ?? null;
	}

	private setHover(nodeId: string | null): void {
		if (nodeId === this.hoverId && this.hoverTarget === (nodeId ? 1 : 0)) return;
		this.hoverId = nodeId;
		// Hover-out deliberately KEEPS hoverNode: the glow must fade out
		// from the last hovered node, not vanish with the id.
		if (nodeId) this.hoverNode = this.nodeById.get(nodeId) ?? null;
		// Rebase the animation from the CURRENT fade: rapid hover toggles
		// glide instead of snapping (ported from the sigma-era behavior).
		this.hoverFrom = this.hoverFade;
		this.hoverTarget = nodeId ? 1 : 0;
		this.hoverStart = performance.now();
		this.animating = true;
		this.markDirty();
	}

	private markDirty(): void {
		this.dirty = true;
		if (this.frameId === null && !this.inTick) {
			this.frameId = requestAnimationFrame(() => {
				this.frameId = null;
				this.tick();
			});
		}
	}

	private tick(): void {
		this.inTick = true;
		try {
			const now = performance.now();
			// Clamp the dt: a long idle gap must not teleport the ease forward.
			const dt = Math.min(Math.max(now - this.lastTickAt, 8), 100);
			this.lastTickAt = now;
			const hoverAnim = this.advanceHover();
			const zoomAnim = this.advanceZoom(dt);
			const simAnim = this.advanceSim();
			this.draw();
			// Keep frames coming ONLY while an animation is in motion (hover
			// fade, zoom glide, or live physics); an idle graph schedules no
			// rAF at all.
			this.animating = hoverAnim || zoomAnim || simAnim;
		} finally {
			this.inTick = false;
		}
		if (this.animating) {
			this.frameId = requestAnimationFrame(() => {
				this.frameId = null;
				this.tick();
			});
		}
	}

	/** One live-sim step; returns true while physics is still in motion.
	 *  Runs only while simActive (drag reheat or post-release anneal). */
	private advanceSim(): boolean {
		if (!this.sim || !this.simActive) return false;
		this.sim.tick();
		// Movement check: did any node actually move (a click-pin that
		// never reheated leaves everything exactly at rest)?
		for (const n of this.sim.nodes()) {
			if (n.vx || n.vy) {
				this.simMoved = true;
				break;
			}
		}
		this.geoVersion++; // positions changed → geometry rebuild in draw()
		// Settled (drag released long ago, alpha annealed away)?
		if (!this.dragId && this.sim.alpha() < SIM_SETTLE_ALPHA) {
			this.simActive = false;
			this.scheduleCommit();
			return false;
		}
		return true;
	}

	/** Debounced rest-state commit. A new drag or setData cancels it. */
	private scheduleCommit(): void {
		if (this.commitTimer) clearTimeout(this.commitTimer);
		this.commitTimer = setTimeout(() => {
			this.commitTimer = null;
			if (!this.data || !this.simMoved) return;
			this.simMoved = false;
			const positions: Record<string, Position> = {};
			for (const n of this.data.nodes) positions[n.id] = { x: n.x, y: n.y };
			this.callbacks.onCommit(positions);
		}, COMMIT_DEBOUNCE_MS);
	}

	/** Hover fade step; returns true while still moving. */
	private advanceHover(): boolean {
		if (this.hoverFade === this.hoverTarget) return false;
		const t = Math.min((performance.now() - this.hoverStart) / HOVER_FADE_MS, 1);
		this.hoverFade = this.hoverFrom + (this.hoverTarget - this.hoverFrom) * t;
		// Outgoing fade finished — release the glow node.
		if (this.hoverTarget === 0 && this.hoverFade === 0) this.hoverNode = null;
		return t < 1;
	}

	/** Zoom glide step: ease k toward the wheel target, keeping the world
	 *  point under the cursor pinned. Frame-rate independent (exponential
	 *  approach, time constant ZOOM_EASE_MS). Returns true while gliding. */
	private advanceZoom(dt: number): boolean {
		const target = this.zoomTarget;
		if (!target) return false;
		const t = this.transform;
		const blend = 1 - Math.exp(-dt / ZOOM_EASE_MS);
		let k = t.k + (target.k - t.k) * blend;
		let done = false;
		if (Math.abs(target.k - k) / target.k < 0.002) {
			k = target.k;
			done = true;
		}
		const scale = k / t.k;
		const x = target.x - (target.x - t.x) * scale;
		const y = target.y - (target.y - t.y) * scale;
		if (done) this.zoomTarget = null;
		// Applied through d3-zoom so constraints + the zoom event (markDirty,
		// onCameraMove) fire exactly as with any other camera change.
		select(this.canvas).call(
			this.zoomBehavior.transform,
			zoomIdentity.translate(x, y).scale(k),
		);
		return !done;
	}

	/** Resize the backing store to the CSS box × devicePixelRatio; all
	 *  drawing then happens in CSS pixels through the DPR transform. */
	private syncSize(): void {
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		const bw = Math.max(1, Math.round(w * dpr));
		const bh = Math.max(1, Math.round(h * dpr));
		if (this.canvas.width !== bw || this.canvas.height !== bh) {
			this.canvas.width = bw;
			this.canvas.height = bh;
		}
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.viewW = w;
		this.viewH = h;
	}

	/** Derive ALL world geometry from data + visibility + settings.
	 *  Runs only when geoVersion moves — never per frame, never per camera
	 *  change. Zoom/pan pay zero geometry math, only rasterization. Sizes
	 *  are WORLD UNITS straight from the settings (the 2026-09-15 pivot —
	 *  no ÷kFit: the world scale is canonical, viewport-independent). */
	private buildGeometry(): void {
		this.builtVersion = this.geoVersion;
		const data = this.data;
		const settings = this.settings;
		if (!data || !settings) return;

		const nodeR = settings.nodeSize;
		this.worldLabelFont = `${LABEL_WEIGHT} ${settings.labelSize}px ${data.fontFamily}`;
		this.world = {
			nodeR,
			glowOuter: nodeR * GLOW_SCALE,
			labelSize: settings.labelSize,
			labelGap: LABEL_GAP,
		};
		const visible = this.visible;
		const isVisible = (id: string) => !visible || visible.has(id);

		// Node discs: one Path2D, one fill() per frame. Implication nodes
		// are pure geometry — never a disc, never a label, never picked.
		const nodesPath = new Path2D();
		for (const n of data.nodes) {
			if (!isVisible(n.id) || isImpNodeId(n.id)) continue;
			nodesPath.moveTo(n.x + nodeR, n.y);
			nodesPath.arc(n.x, n.y, nodeR, 0, Math.PI * 2);
		}
		this.nodesPath = nodesPath;

		// Edge shafts + arrowheads (rendering arc, owner 2026-09-30): all
		// arrows are PLAIN single shafts — the old double-shaft glyph is
		// gone entirely. An argument's geometry: lines INTO an implication
		// node are HEADLESS and run all the way to the imp node's CENTER
		// (co-premise lines converge to a point); the line OUT of it starts
		// at the center and its arrowhead lands on the conclusion's disc
		// edge. Single-premise arguments arrive here as ordinary
		// proposition→proposition edges and draw exactly like any arrow.
		const glyphs = edgeGlyphs(data.edges, this.nodeById, isVisible, nodeR, settings.arrowLength);
		const shafts = new Path2D();
		const heads = new Path2D();
		const sh = glyphs.shafts;
		for (let i = 0; i < sh.length; i += 4) {
			shafts.moveTo(sh[i]!, sh[i + 1]!);
			shafts.lineTo(sh[i + 2]!, sh[i + 3]!);
		}
		const hd = glyphs.heads;
		for (let i = 0; i < hd.length; i += 6) {
			heads.moveTo(hd[i]!, hd[i + 1]!);
			heads.lineTo(hd[i + 2]!, hd[i + 3]!);
			heads.lineTo(hd[i + 4]!, hd[i + 5]!);
			heads.closePath();
		}
		this.shaftsPath = shafts;
		this.headsPath = heads;

		// Cluster regions are NOT built here: they rasterize into their own
		// low-res bitmap (see buildRegions), on their own rebuild schedule
		// (live-sim frames skip 2 of 3 rebuilds and blit the last bitmap).

		// Label wrapping: measureText once per node per geometry build,
		// never per frame. Wrap width keeps the bigger-label/bigger-wrap
		// behavior from the sigma era.
		this.labelLines = new Map();
		const ctx = this.ctx;
		const prevFont = ctx.font;
		ctx.font = this.worldLabelFont;
		const maxW = labelWrapWidth(settings.labelSize);
		const measure = (text: string) => ctx.measureText(text).width;
		for (const n of data.nodes) {
			if (isVisible(n.id) && !isImpNodeId(n.id)) this.labelLines.set(n.id, wrapLabel(n.label, maxW, measure));
		}
		ctx.font = prevFont;
	}

	/** (Re)create the live sim from data.nodes at their current
	 *  positions + the current physics tuning. Called by setData and
	 *  setPhysicsTuning. */
	private buildSim(): void {
		const data = this.data;
		if (!data || data.nodes.length === 0) {
			this.sim = null;
			this.simById = new Map();
			return;
		}
		const t = this.physicsTuning;
		this.sim = createGraphSimulation(data.nodes, data.edges, {
			logicalEdges: data.logicalEdges,
			impLinks: data.impLinks,
			gravity: { x: this.simCenter.x, y: this.simCenter.y, strength: t.gravity },
			alphaDecay: LIVE_ALPHA_DECAY,
			velocityDecay: t.velocityDecay,
			chargeStrength: t.chargeStrength,
			linkStrength: t.linkStrength,
			linkDistance: t.linkDistance,
			clusterPull:
				data.clusters.length > 0 ? { clusters: data.clusters, strength: t.clusterPull } : undefined,
			depthAnchor:
				t.depthMode === "off"
					? undefined
					: {
							mode: t.depthMode,
							strength: t.depthStrength,
							spacing: t.depthSpacing,
							baseRadius: t.depthBaseRadius,
							center: this.simCenter,
						},
		});
		this.simById = new Map(data.nodes.map((n) => [n.id, n as LayoutNode]));
		// Hygiene (2026-09-23 fix wave): a fresh sim starts at alpha 1 and
		// never decays while stopped — so the first post-rebuild drag would
		// re-anneal the whole graph at full strength (alphaTarget(0.3)
		// glides DOWN from 1 instead of gently up from rest). Initialize at
		// the settle floor so first-drag behavior matches steady-state
		// drags. setPhysicsTuning still rehearses its explicit alpha(1)
		// when a full re-anneal IS the point.
		this.sim.alpha(SIM_SETTLE_ALPHA);
	}

	/** Rasterize cluster regions into the low-res world-space bitmap.
	 *  Runs on data/visibility/settings changes at rest, and every
	 *  REGION_EVERY-th frame while the live sim moves nodes (the in-between
	 *  frames blit the previous bitmap — one sim step of staleness at
	 *  120fps is invisible). Positions come straight from data.nodes. */
	private buildRegions(): void {
		const data = this.data;
		if (!data || data.clusters.length === 0) {
			this.regionCanvas = null;
			this.regionRect = null;
			this.regionMeta = [];
			return;
		}
		const visible = this.visible;
		const isVisible = (id: string): boolean => !visible || visible.has(id);

		const tuning = this.regionTuning;
		// Label anchors ALWAYS compute (cheap — a centroid pass, no canvas):
		// cluster labels follow their own `clusterLabels` setting and must
		// survive the region paint being turned off.
		this.regionMeta = regionAnchors(data.clusters, this.nodeById, isVisible).map((a) => ({
			...a,
			lines: null,
		}));
		if (this.regionMeta.length === 0) {
			this.regionCanvas = null;
			this.regionRect = null;
			return;
		}

		// Wrap the region labels ONCE per geometry build, at their
		// SCREEN-fixed size (viewer-relative labels — this px size is what
		// lands on screen at any zoom, so the wrap never goes stale mid-
		// camera-move). Session names are short; file paths are not (wave
		// 7) — the cap + ellipsis keeps the footprint bounded.
		const settings = this.settings;
		if (settings) {
			const ctx = this.ctx;
			const prevFont = ctx.font;
			ctx.font = `${LABEL_WEIGHT} ${settings.clusterLabelSize}px ${data.fontFamily}`;
			for (const rm of this.regionMeta) {
				rm.lines = rm.label
					? wrapRegionLabel(rm.label, REGION_LABEL_MAX_WIDTH, REGION_LABEL_MAX_LINES, (s) => ctx.measureText(s).width)
					: null;
			}
			ctx.font = prevFont;
		}

		// THE off switch (user 2026-09-15): compute is skipped, not just
		// paint hidden — no splat, no blur, no readback, no bitmap, no
		// blit. Everything below this return is the bitmap path.
		if (!tuning.enabled) {
			this.regionCanvas = null;
			this.regionRect = null;
			return;
		}

		// The splat plan (src/core regionSplat): the bitmap size, the cell,
		// and the round-cap strokes and discs of each cluster. Dilation and
		// blur are WORLD units (the 2026-09-15 pivot).
		const plan = regionSplat(data.clusters, data.edges, this.nodeById, isVisible, tuning);
		if (!plan) {
			this.regionCanvas = null;
			this.regionRect = null;
			return;
		}
		const bw = plan.width;
		const bh = plan.height;
		let rc = this.regionCanvas;
		if (!rc) {
			rc = document.createElement("canvas");
			this.regionCanvas = rc;
		}
		if (rc.width !== bw || rc.height !== bh) {
			rc.width = bw;
			rc.height = bh; // also clears
		}
		// willReadFrequently: the blur step getImageData/putImageData every
		// rebuild — Chrome keeps this canvas on the CPU instead of GPU-
		// shuttling it.
		const rctx = rc.getContext("2d", { willReadFrequently: true });
		if (!rctx) return;
		rctx.clearRect(0, 0, bw, bh);
		rctx.lineCap = "round";
		rctx.lineWidth = plan.lineWidth;

		// The region IS the dilated skeleton: intra-cluster edges as
		// round-cap strokes, plus one disc for each member no stroke reached
		// (every member is painted once, never twice). Full-opacity paint:
		// alpha is applied ONCE at the very end (dilate at 1 → blur → scale
		// by edgeAlpha), so overlaps of any count contribute exactly 1.0.
		for (const layer of plan.layers) {
			const color = `hsla(${layer.hue}, 65%, ${data.colors.clusterLightness.ring}%, 1)`;
			rctx.strokeStyle = color;
			rctx.beginPath();
			const sg = layer.segments;
			for (let i = 0; i < sg.length; i += 4) {
				rctx.moveTo(sg[i]!, sg[i + 1]!);
				rctx.lineTo(sg[i + 2]!, sg[i + 3]!);
			}
			rctx.stroke();
			rctx.fillStyle = color;
			const dc = layer.discs;
			for (let i = 0; i < dc.length; i += 2) {
				rctx.beginPath();
				rctx.arc(dc[i]!, dc[i + 1]!, plan.discR, 0, Math.PI * 2);
				rctx.fill();
			}
		}

		// THE blur + alpha (in that order, by design — user-decided
		// 2026-09-14): 3 box-blur rounds on the premultiplied bitmap, THEN
		// scale the whole field by edgeAlpha once (src/core
		// blurRegionPixels). Radius 0 (blur off) still runs this path, so
		// the end-alpha applies uniformly with or without blur.
		const img = rctx.getImageData(0, 0, bw, bh);
		blurRegionPixels(img.data, bw, bh, plan.blurPx, tuning.edgeAlpha);
		rctx.putImageData(img, 0, 0);
		this.regionRect = plan.rect;
	}

	/** THE draw function: every layer, one frame, one camera. All drawing
	 *  happens in WORLD coordinates under the camera transform; nothing is
	 *  recomputed per frame except layer styling. */
	private draw(): void {
		this.dirty = false;
		const data = this.data;
		const settings = this.settings;
		if (!data || !settings) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		const ctx = this.ctx;

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);

		this.frameCount++;
		// Regions: rebuild on stale geometry at rest; during the live sim,
		// every REGION_EVERY-th frame (others blit the last bitmap).
		if (
			this.regionBuiltVersion !== this.geoVersion &&
			(!this.simActive || this.frameCount % REGION_EVERY === 0)
		) {
			this.buildRegions();
			this.regionBuiltVersion = this.geoVersion;
		}
		if (this.builtVersion !== this.geoVersion) this.buildGeometry();
		if (!this.nodesPath) return;

		const { x: tx, y: ty, k } = this.transform;
		// THE camera: one transform, then everything is world coordinates.
		ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);

		const ratio = zoomRatioOf(this.kFit, k);
		const nodeAlpha = labelAlpha(ratio, settings.labelZoom);
		const regionAlpha = 1 - nodeAlpha;
		const { nodeR, glowOuter } = this.world;

		// 1. Cluster regions: one tiny world-space bitmap blit. The upscale
		//    blur is the region softness; adjacent cluster tints blend
		//    source-over where they overlap (decided: multiply is invisible
		//    on the dark background).
		if (this.regionCanvas && this.regionRect) {
			const { minX, minY, w, h } = this.regionRect;
			ctx.imageSmoothingEnabled = true;
			ctx.drawImage(this.regionCanvas, minX, minY, w, h);
		}

		// 3. Edges: shafts + arrowheads from cached paths; width constant on
		// screen (÷ k), geometry in world units (scales with the graph).
		// Supports shafts: a second, thinner stroke (owner, 2026-09-29) —
		// heads share the one fill at full geometry (shaft-only ruling).
		// A true 0-width stroke is undefined on canvas: the ratio's 0 end
		// floors to a hairline (0.5px on screen — hiding is the toggle's).
		if (settings.edgeWidth > 0) {
			ctx.strokeStyle = data.colors.edge;
			ctx.fillStyle = data.colors.edge;
			ctx.lineWidth = settings.edgeWidth / k;
			ctx.lineCap = "round";
			ctx.stroke(this.shaftsPath);
			ctx.fill(this.headsPath);
		}

		// 4. Nodes: one cached Path2D, one fill.
		ctx.fillStyle = data.colors.node;
		ctx.fill(this.nodesPath);

		// 6. Node labels — one global gate, faded together. World-scaled
		// with the graph (they grow as you zoom in, Obsidian-style).
		if (nodeAlpha > 0.01) {
			ctx.save();
			ctx.globalAlpha = nodeAlpha;
			ctx.font = this.worldLabelFont;
			for (const [id, lines] of this.labelLines) {
				const n = this.nodeById.get(id);
				if (!n) continue;
				drawNameLines(ctx, n.x, n.y, lines, this.world, data.colors.label);
			}
			ctx.restore();
		}

		// 7. Hover glow (topmost): halo in the node's color + the brightened
		// name, both on the SAME fade factor. World units like everything
		// else. Shows even when labels are zoomed out (hover is its own
		// affordance, not a label).
		if (this.hoverNode && this.hoverFade > 0.02) {
			const n = this.visible && !this.visible.has(this.hoverNode.id)
				? null // filtered out by search — no glow on hidden nodes
				: this.hoverNode;
			if (n) {
				const glow = ctx.createRadialGradient(n.x, n.y, nodeR, n.x, n.y, glowOuter);
				glow.addColorStop(0, rgbaFromHex(data.colors.node, GLOW_ALPHA * this.hoverFade));
				glow.addColorStop(1, rgbaFromHex(data.colors.node, 0));
				ctx.fillStyle = glow;
				ctx.beginPath();
				ctx.arc(n.x, n.y, glowOuter, 0, Math.PI * 2);
				ctx.arc(n.x, n.y, nodeR, 0, Math.PI * 2, true);
				ctx.fill("evenodd");
				ctx.save();
				ctx.globalAlpha = this.hoverFade;
				ctx.font = this.worldLabelFont;
				drawNameLines(ctx, n.x, n.y, this.labelLines.get(n.id) ?? [], this.world, data.colors.hoverText);
				ctx.restore();
			}
		}

		// 8. Cluster region labels — THE TOPMOST layer (user 2026-09-16:
		// node labels and hover names drew over them before; region labels
		// must never be occluded by content). Inverse-gated on THE zoom
		// control (visible zoomed-out, fading as node labels come in).
		// Viewer-relative by design (UI, not graph content): drawn at the
		// world centroid with a font of clusterLabelSize / k — a constant
		// size on screen at any zoom (user-tunable since 2026-09-16).
		// Wave 7: labels are session names / file paths — pre-wrapped at
		// the geometry build (cap + ellipsis), drawn centered on the
		// centroid line by line.
		if (settings.clusterLabels && regionAlpha > 0.01) {
			ctx.save();
			ctx.globalAlpha = regionAlpha;
			ctx.font = `${LABEL_WEIGHT} ${settings.clusterLabelSize / k}px ${data.fontFamily}`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			// Screen px ÷ k = world units — the lines stay evenly spaced
			// at a constant on-screen pitch at any zoom.
			const lineH = (settings.clusterLabelSize * REGION_LABEL_LINE_HEIGHT) / k;
			for (const rm of this.regionMeta) {
				if (!rm.lines) continue;
				ctx.fillStyle = `hsla(${rm.hue}, 55%, ${data.colors.clusterLightness.label}%, 0.85)`;
				const firstOffset = (-(rm.lines.length - 1) / 2) * lineH;
				for (let i = 0; i < rm.lines.length; i++) {
					ctx.fillText(rm.lines[i]!, rm.cx, rm.cy + firstOffset + i * lineH);
				}
			}
			ctx.restore();
		}
	}
}
