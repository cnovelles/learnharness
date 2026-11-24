/**
 * The theme wave's pure core (src/core/themes.ts): the import validator,
 * the presets, the theme → CSS-token adapter (Default pinned against the
 * app/globals.css literals), override precedence across the two override
 * homes, and the export.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
	BUILTIN_THEMES,
	DEFAULT_THEME,
	effectiveColors,
	exportThemeFile,
	parseThemeFile,
	resolveTheme,
	sanitizeThemeFile,
	THEME_COLOR_KEYS,
	themeIdFromName,
	themeVars,
	type Theme,
} from "../src/core/index.ts";

const mocha = BUILTIN_THEMES.find((t) => t.id === "catppuccin-mocha")!;
const validFile = { name: "My Ayu", mode: "dark", colors: { ...mocha.colors } };

describe("theme files — the import validator", () => {
	it("accepts the documented shape and drops unknown keys", () => {
		const out = sanitizeThemeFile({ ...validFile, author: "me", colors: { ...validFile.colors, extra: "#000" } });
		assert.deepEqual(out, validFile);
	});

	it("names the first bad field", () => {
		const { error: _drop, ...noError } = validFile.colors;
		const cases: Array<[unknown, RegExp]> = [
			[[1], /JSON object/],
			[{ ...validFile, name: "  " }, /name/],
			[{ ...validFile, mode: "sepia" }, /mode/],
			[{ ...validFile, colors: "red" }, /colors must be an object/],
			[{ ...validFile, colors: noError }, /colors\.error/],
			[{ ...validFile, colors: { ...validFile.colors, text: "white" } }, /colors\.text/],
		];
		for (const [raw, message] of cases) {
			const parsed = parseThemeFile(raw);
			assert.equal(parsed.ok, false, JSON.stringify(raw));
			assert.match(!parsed.ok ? parsed.error : "", message);
		}
	});

	it("ids are name slugs, accents folded", () => {
		assert.equal(themeIdFromName("Rosé Pine Moon"), "rose-pine-moon");
		assert.equal(themeIdFromName("  My   Ayu!! "), "my-ayu");
		assert.equal(themeIdFromName("!!!"), "");
		assert.equal(themeIdFromName(`${"a".repeat(63)} b`), "a".repeat(63), "trim after truncation");
		assert.equal(themeIdFromName("a".repeat(100)), "a".repeat(64));
	});
});

describe("presets", () => {
	it("every preset is a valid theme file with a unique id matching its name", () => {
		const ids = new Set<string>();
		for (const t of BUILTIN_THEMES) {
			assert.ok(sanitizeThemeFile(t), t.id);
			assert.ok(!ids.has(t.id), `duplicate ${t.id}`);
			ids.add(t.id);
			// The default keeps the id "default" under its new name (issue 22).
			assert.equal(t.id, t.id === "default" ? "default" : themeIdFromName(t.name));
			assert.equal(t.builtin, true);
		}
		assert.deepEqual([...ids], [
			"default", "orbitutor-light", "classic", "catppuccin-latte", "catppuccin-frappe", "catppuccin-macchiato", "catppuccin-mocha",
			"rose-pine", "rose-pine-dawn", "gruvbox-dark", "ivory", "pastel", "nvchad-onedark",
		]);
	});

	it("an unknown or removed id resolves to Default", () => {
		assert.equal(resolveTheme(undefined), DEFAULT_THEME);
		assert.equal(resolveTheme("gone"), DEFAULT_THEME);
		const custom: Theme = { ...validFile, mode: "dark", id: "my-ayu", builtin: false };
		assert.equal(resolveTheme("my-ayu", [custom]), custom);
	});
});

/** The declarations of the block opening with `selector {`. */
function cssBlock(css: string, selector: string): Map<string, string> {
	const start = css.indexOf(`${selector} {`);
	assert.ok(start >= 0, `missing ${selector}`);
	const body = css.slice(start, css.indexOf("}", start));
	const out = new Map<string, string>();
	for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
	return out;
}

describe("themeVars — the adapter", () => {
	it("Default reproduces app/globals.css's literals exactly", () => {
		const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
		const block = cssBlock(css, ":root,\n.dark");
		for (const [token, value] of Object.entries(themeVars(DEFAULT_THEME.colors, "dark", DEFAULT_THEME.buttons))) {
			assert.equal(block.get(token), value, token);
		}
	});

	it("the hover surface derives from surface; the theme accent goes to --lh-accent", () => {
		const dark = themeVars(mocha.colors, "dark");
		assert.equal(dark["--accent"], "#3f4052", "surface #313244 + 14 per channel");
		assert.equal(dark["--lh-accent"], mocha.colors.accent);
		assert.equal(dark["--ring"], mocha.colors.accent);
		const latte = BUILTIN_THEMES.find((t) => t.id === "catppuccin-latte")!;
		assert.equal(themeVars(latte.colors, "light")["--accent"], "#d8dbe1", "light hovers darken: mantle #e6e9ef − 14");
	});

	it("emphasis and status inks come straight from the theme", () => {
		const v = themeVars(mocha.colors, "dark");
		assert.equal(v["--lh-ink-strong"], mocha.colors.bold);
		assert.equal(v["--lh-ink-italic"], mocha.colors.italic);
		assert.equal(v["--lh-ink-code"], mocha.colors.code);
		assert.equal(v["--lh-error"], mocha.colors.error);
		assert.equal(v["--destructive"], mocha.colors.error);
		assert.equal(v["--lh-success"], mocha.colors.success);
		assert.equal(v["--lh-warning"], mocha.colors.warning);
	});
});

describe("OrbiTutor presets (issue 22, palette Grove)", () => {
	const light = BUILTIN_THEMES.find((t) => t.id === "orbitutor-light")!;

	it("the default id is OrbiTutor dark; the old palette is Classic", () => {
		assert.equal(DEFAULT_THEME.id, "default");
		assert.equal(DEFAULT_THEME.name, "OrbiTutor");
		assert.equal(DEFAULT_THEME.mode, "dark");
		assert.equal(light.mode, "light");
		const classic = BUILTIN_THEMES.find((t) => t.id === "classic")!;
		assert.equal(classic.colors.background, "#141414");
		assert.equal(classic.colors.accent, "#8d8d8d");
		assert.equal(classic.buttons, undefined);
	});

	it("buttons fill --primary; a theme without buttons keeps text on the page color", () => {
		const v = themeVars(DEFAULT_THEME.colors, "dark", DEFAULT_THEME.buttons);
		assert.equal(v["--primary"], "#2fd08a");
		assert.equal(v["--primary-foreground"], "#0b2117");
		const m = themeVars(mocha.colors, "dark", mocha.buttons);
		assert.equal(m["--primary"], mocha.colors.text);
		assert.equal(m["--primary-foreground"], mocha.colors.background);
	});

	it("every text pair passes WCAG AA (4.5:1), and the status inks 3:1", () => {
		const lum = (hex: string) => {
			const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
				.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
			return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
		};
		const ratio = (a: string, b: string) => {
			const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
			return (x! + 0.05) / (y! + 0.05);
		};
		for (const t of [DEFAULT_THEME, light]) {
			const c = t.colors;
			const pairs: Array<[string, string, number]> = [
				[c.text, c.background, 4.5], [c.text, c.surface, 4.5], [c.textMuted, c.background, 4.5],
				[c.textMuted, c.surface, 4.5], [c.accent, c.background, 4.5], [c.italic, c.background, 4.5],
				[c.bold, c.background, 4.5], [c.code, c.background, 4.5], [c.error, c.background, 4.5],
				[t.buttons!.onPrimary, t.buttons!.primary, 4.5], [c.success, c.background, 3], [c.warning, c.background, 3],
			];
			for (const [fg, bg, need] of pairs) {
				assert.ok(ratio(fg, bg) >= need, `${t.id}: ${fg} on ${bg} = ${ratio(fg, bg).toFixed(2)}`);
			}
		}
	});

	it("an import may carry buttons; bad buttons name the field", () => {
		const withButtons = { ...validFile, buttons: { primary: "#2fd08a", onPrimary: "#0b2117" } };
		assert.deepEqual(sanitizeThemeFile(withButtons), withButtons);
		assert.match((parseThemeFile({ ...validFile, buttons: "green" }) as { error: string }).error, /buttons must be an object/);
		assert.match((parseThemeFile({ ...validFile, buttons: { primary: "#2fd08a" } }) as { error: string }).error, /buttons\.onPrimary/);
	});
});

describe("effectiveColors — overrides over the theme", () => {
	it("no overrides = the theme", () => {
		assert.deepEqual(effectiveColors(mocha, undefined), mocha.colors);
		assert.deepEqual(effectiveColors(mocha, { background: null, colors: { warning: null } }), mocha.colors);
	});

	it("each override wins from its home: background, mdRendering inks, colors", () => {
		const c = effectiveColors(mocha, {
			background: "#101010",
			mdRendering: { boldColor: "#ff0000", italicColor: "#00ff00" },
			colors: { warning: "#fab387", surface: "#222" },
		});
		assert.equal(c.background, "#101010");
		assert.equal(c.bold, "#ff0000");
		assert.equal(c.italic, "#00ff00");
		assert.equal(c.warning, "#fab387");
		assert.equal(c.surface, "#222");
		assert.equal(c.text, mocha.colors.text);
	});
});

describe("graph edges", () => {
	it("draw in each theme's muted text, never the highlight accent", () => {
		for (const t of BUILTIN_THEMES) {
			assert.equal(themeVars(t.colors, t.mode)["--muted-foreground"], t.colors.textMuted, t.id);
		}
		const view = fs.readFileSync(new URL("../components/graph-view.tsx", import.meta.url), "utf8");
		assert.match(view, /edge: tokenHex\("--muted-foreground"\)/);
	});
});

describe("exportThemeFile", () => {
	it("is the theme with every override applied, all 12 keys", () => {
		const out = exportThemeFile(mocha, { colors: { warning: "#fab387" } });
		assert.deepEqual(out, { name: "Catppuccin Mocha", mode: "dark", colors: { ...mocha.colors, warning: "#fab387" } });
		assert.deepEqual(Object.keys(out.colors).sort(), [...THEME_COLOR_KEYS].sort());
		assert.ok(sanitizeThemeFile(out), "an export is always importable");
	});
});
