#!/usr/bin/env node
/**
 * Generates editor IntelliSense data for <movi-player>.
 *
 * Everything here is DERIVED, never hand-maintained:
 *   - which attributes exist  →  observedAttributes in src/render/MoviElement.ts
 *   - what each one means     →  docs/api/element.md + docs/guide/custom-element.md
 *   - which values it accepts →  the "**Values:**" bullet lists in those docs
 *   - CSS custom properties   →  the --movi-* declarations in the element's styles
 *   - DOM events              →  the element event table in docs/api/events.md
 *   - CSS shadow parts        →  the part= attributes in src/render/*.ts
 *   - slots                   →  the <slot name=> elements in src/render/*.ts
 *
 * That direction matters. A hand-written copy of the attribute list is exactly
 * how the docs drifted from the code before (events that were documented but
 * never dispatched, attributes the reference had never heard of). Deriving it
 * means the completions cannot describe an attribute the element doesn't have,
 * and the build FAILS if an attribute exists with nothing documenting it — so
 * the next new attribute has to be documented before it can ship.
 *
 * Outputs:
 *   custom-elements.json                       Custom Elements Manifest (every editor)
 *   vscode-extension/html-custom-data.json     VS Code HTML completions
 *   vscode-extension/css-custom-data.json      VS Code CSS custom-property completions
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const ELEMENT_SRC = read("src/render/MoviElement.ts");
// Parts and slots are not all in MoviElement: caption lines are written by the
// renderer, and the native fallback writes its own. Scanning only the element
// would have silently dropped `subtitle` from the manifest.
const SHADOW_SRC = [
  ELEMENT_SRC,
  read("src/render/CanvasRenderer.ts"),
  read("src/render/NativeVideoWrapper.ts"),
].join("\n");
const DOC_ELEMENT = read("docs/api/element.md");
const DOC_GUIDE = read("docs/guide/custom-element.md");
const DOC_EVENTS = read("docs/api/events.md");
const PKG = JSON.parse(read("package.json"));

// Derived from package.json rather than hardcoded, so the "Documentation" link
// on every completion follows the published site if it ever moves. Matches the
// canonical VitePress emits: `${homepage}/docs/${path}`.
const DOCS_BASE = `${PKG.homepage.replace(/\/$/, "")}/docs/api/element`;

/* ---------------------------------------------------------------- attributes */

function observedAttributes() {
  const start = ELEMENT_SRC.indexOf("static get observedAttributes");
  if (start < 0) throw new Error("observedAttributes not found in MoviElement.ts");
  const end = ELEMENT_SRC.indexOf("];", start);
  const names = [...ELEMENT_SRC.slice(start, end).matchAll(/"([a-z0-9-]+)"/g)].map(
    (m) => m[1],
  );
  if (!names.length) throw new Error("observedAttributes parsed as empty");
  return names;
}

/**
 * The keys of the `MoviPlayerAttributes` interface in src/element.ts — the type
 * that backs the React/Vue/Svelte wrappers' declarative props. It is hand-typed
 * (the value types are JSX-shaped: `boolean | ""`, literal unions) so it can't
 * simply be generated, but its KEY SET must stay equal to observedAttributes,
 * or a new attribute lands with no autocomplete in any framework wrapper — which
 * is the exact gap this whole pipeline exists to prevent.
 */
function interfaceKeys() {
  const src = read("src/element.ts");
  const k = src.indexOf("export interface MoviPlayerAttributes");
  if (k < 0) throw new Error("MoviPlayerAttributes not found in src/element.ts");
  const end = src.indexOf("\n}", k);
  return [...src.slice(k, end).matchAll(/^\s{2}([a-z0-9]+)\??:/gm)].map((m) => m[1]);
}

function assertInterfaceCovers(attrs) {
  const keys = new Set(interfaceKeys());
  const missing = attrs.filter((a) => !keys.has(a));
  const extra = [...keys].filter((k) => !attrs.includes(k));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length)
      parts.push(`missing from the type: ${missing.join(", ")}`);
    if (extra.length) parts.push(`no such attribute: ${extra.join(", ")}`);
    throw new Error(
      `MoviPlayerAttributes (src/element.ts) is out of sync with observedAttributes — ${parts.join("; ")}.\n` +
        `That interface backs the React/Vue/Svelte wrappers' props, so it must\n` +
        `list every attribute and nothing else. Add/remove the entry to match.`,
    );
  }
}

/** The body of the `#### \`attr\`` section, stopping at the next `---` rule. */
function docSection(doc, attr) {
  const esc = attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading =
    new RegExp(`^#{2,5}\\s+\`${esc}\`(?:\\s*/\\s*\`[a-z0-9-]+\`)?\\s*$`, "m").exec(doc) ??
    new RegExp(`^#{2,5}\\s+\`[a-z0-9-]+\`\\s*/\\s*\`${esc}\`\\s*$`, "m").exec(doc);
  if (!heading) return null;
  const body = doc.slice(heading.index + heading[0].length);
  return body.split(/\n---\n/)[0];
}

/** First real prose line — skips fences, bold labels, admonitions, tables. */
function firstProse(section) {
  if (!section) return null;
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(```|\*\*|:::|\||#|-)/.test(line)) continue;
    return line;
  }
  return null;
}

/** Cells of the `| \`attr\` | ... |` row, if the attribute is documented as one. */
function tableCells(doc, attr) {
  const esc = attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^\\|\\s*\`${esc}\`\\s*\\|(.+)$`, "m").exec(doc);
  if (!m) return null;
  const cells = m[1]
    .split("|")
    .map((c) => c.trim())
    .filter(Boolean);
  return cells.length ? cells : null;
}

/** The row's description — always the last cell. */
function tableRow(doc, attr) {
  const cells = tableCells(doc, attr);
  return cells ? cells[cells.length - 1] : null;
}

/**
 * Values listed inside a table row rather than a "**Values:**" list — the guide
 * tabulates them in a dedicated column (e.g. rotate: `0`, `90`, `180`, `270`).
 *
 * The column is located by NAME from the table's own header, not by position or
 * by "looks like a list of literals". Guessing picked the Type column instead
 * and offered `sw="boolean"` / `sw="string"` as if they were values.
 */
function tableValues(doc, attr) {
  const esc = attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const row = new RegExp(`^\\|\\s*\`${esc}\`\\s*\\|.+$`, "m").exec(doc);
  if (!row) return [];

  // Walk back to the table's |---|---| separator: the header is the line above
  // it. Taking "the nearest preceding line starting with |" instead just found
  // the previous ATTRIBUTE row and read its cells as column names.
  const before = doc.slice(0, row.index).split("\n");
  let header = null;
  for (let i = before.length - 1; i >= 1 && before.length - i < 120; i--) {
    if (/^\|[\s:|-]+\|?$/.test(before[i].trim())) {
      header = before[i - 1].trim();
      break;
    }
  }
  if (!header || !header.startsWith("|")) return [];

  const cols = header.split("|").map((c) => c.trim().toLowerCase());
  const at = cols.indexOf("values");
  if (at < 0) return [];

  const cell = (row[0].split("|")[at] ?? "").trim();
  const literals = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const values = literals.filter(isLiteralValue);
  if (values.length < 2) return [];
  return values.map((name) => ({ name }));
}

/** `- \`value\` (default) — description` bullets under a "**Values:**" label. */
function docValues(section) {
  if (!section) return [];
  const at = section.indexOf("**Values:**");
  if (at < 0) return [];
  const out = [];
  for (const raw of section.slice(at).split("\n").slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith("-")) break;
    const m = /^-\s*`?([^`\s(]+)`?/.exec(line);
    if (!m) continue;
    const name = m[1].replace(/[*_`]/g, "");
    if (!name || name === "(unset,") continue;
    const rest = line.slice(m[0].length).replace(/^[\s—-]+/, "").trim();
    // A type placeholder in the list means the set is OPEN — fps documents
    // "`0`" and "`number`", i.e. zero or any frame rate. Offering just `0` as a
    // closed enum would read as the only legal value. Suggest nothing instead.
    if (!isLiteralValue(name)) return [];
    out.push({ name, description: rest || undefined });
  }
  return out;
}

/**
 * Docs use bare type names as placeholders inside value lists — fps documents
 * "`number` — Fixed frame rate (e.g. 24, 60)". That is a type, not a literal, and
 * completing it would insert `fps="number"`. Drop them; a real literal like `0`
 * that happens to sit in the same list survives.
 */
const TYPE_PLACEHOLDERS = new Set([
  "number",
  "string",
  "boolean",
  "object",
  "array",
  "any",
  "null",
  "undefined",
]);
const isLiteralValue = (name) => !TYPE_PLACEHOLDERS.has(name.toLowerCase());

function stripMd(s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

function buildAttributes() {
  const missing = [];
  const attrs = observedAttributes().map((name) => {
    const section = docSection(DOC_ELEMENT, name) ?? docSection(DOC_GUIDE, name);
    const description =
      firstProse(section) ?? tableRow(DOC_GUIDE, name) ?? tableRow(DOC_ELEMENT, name);
    if (!description) missing.push(name);
    const values = docValues(section);
    return {
      name,
      description: description ?? "",
      values: values.length ? values : tableValues(DOC_GUIDE, name),
    };
  });

  if (missing.length) {
    throw new Error(
      `No documentation found for ${missing.length} attribute(s): ${missing.join(", ")}\n` +
        `Add a "#### \`name\`" section to docs/api/element.md (or a table row in\n` +
        `docs/guide/custom-element.md) before shipping the attribute — the editor\n` +
        `completions are generated from the docs, so an undocumented attribute\n` +
        `would appear with no explanation.`,
    );
  }
  return attrs;
}

/* --------------------------------------------------------- CSS custom props */

function buildCssProperties() {
  const seen = new Map();
  for (const m of ELEMENT_SRC.matchAll(/(--movi-[a-z0-9-]+)\s*:\s*([^;\n]+);/g)) {
    const [, name, value] = m;
    // First declaration wins: that is the :host default, before any theme or
    // state override further down the sheet.
    if (!seen.has(name)) seen.set(name, value.trim());
  }
  return [...seen].map(([name, value]) => ({
    name,
    description: `MoviPlayer theme variable.\n\nDefault: \`${value}\``,
  }));
}

/* ------------------------------------------------------------ parts + slots */

/**
 * Every `part=` the shadow trees carry, and every named `<slot>`, described
 * from the tables in docs/api/element.md.
 *
 * Same contract as the attributes above: the source decides what EXISTS and the
 * docs decide what it MEANS, and a part with nothing describing it fails the
 * build. That direction is the point — docs/api/element.md promised
 * `::part(error-screen)` and `::part(subtitle)` for two releases while neither
 * was in the markup, which is the drift this file exists to make impossible.
 */
const DOC_PART_ROWS = (() => {
  const rows = new Map();
  const lines = DOC_ELEMENT.split("\n");
  let inTable = false;
  for (const line of lines) {
    if (!line.startsWith("|")) {
      inTable = false;
      continue;
    }
    // Only tables that ARE the parts tables — the reference is full of other
    // two-column tables, and a whole-document search matched `osd` and
    // `progress` against rows describing the attribute and the event of the
    // same name.
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length === 2 && cells[0].toLowerCase() === "part") {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (/^-+$/.test(cells[0].replace(/[\s:]/g, ""))) continue;
    const names = [...cells[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const description = stripMd(cells[1] ?? "");
    for (const name of names) if (!rows.has(name)) rows.set(name, description);
  }
  return rows;
})();

function buildParts() {
  const names = new Set();
  for (const m of SHADOW_SRC.matchAll(/\bpart="([^"]+)"/g))
    for (const n of m[1].split(/\s+/)) if (n) names.add(n);
  for (const m of SHADOW_SRC.matchAll(/setAttribute\(\s*"part"\s*,\s*"([^"]+)"/g))
    for (const n of m[1].split(/\s+/)) if (n) names.add(n);

  const out = [];
  const missing = [];
  for (const name of [...names].sort()) {
    const description = DOC_PART_ROWS.get(name);
    if (!description) missing.push(name);
    out.push({ name, description: description ?? "" });
  }
  if (missing.length) {
    throw new Error(
      `No documentation found for ${missing.length} shadow part(s): ${missing.join(", ")}\n` +
        `Add a "| \`name\` | what it is |" table row to docs/api/element.md before\n` +
        `shipping the part — a part= is public API a page can style, and one with\n` +
        `nothing describing it is one nobody can find.`,
    );
  }
  return out;
}

function buildSlots() {
  const names = new Set();
  for (const m of SHADOW_SRC.matchAll(/<slot\s+name="([^"]+)"/g)) names.add(m[1]);
  return [...names].sort().map((name) => ({
    name,
    description: `Light-DOM children with slot="${name}" are drawn instead of the built-in one.`,
  }));
}

/* ---------------------------------------------------------------- DOM events */

function buildEvents() {
  const startAt = DOC_EVENTS.indexOf("## MoviElement DOM Events");
  if (startAt < 0) return [];
  const stopAt = DOC_EVENTS.indexOf("### Parity with", startAt);
  const table = DOC_EVENTS.slice(startAt, stopAt > 0 ? stopAt : undefined);
  const out = [];
  for (const m of table.matchAll(/^\|\s*`([a-zA-Z-]+)`\s*\|([^|]*)\|([^|]*)\|/gm)) {
    const [, name, payload, description] = m;
    out.push({
      name,
      description: stripMd(description),
      type: { text: stripMd(payload) === "—" ? "Event" : `CustomEvent<${stripMd(payload)}>` },
    });
  }
  return out;
}

/* ------------------------------------------------------------------- outputs */

const attributes = buildAttributes();
assertInterfaceCovers(attributes.map((a) => a.name));
const cssProperties = buildCssProperties();
const events = buildEvents();
const cssParts = buildParts();
const slots = buildSlots();

const TAG_DESCRIPTION =
  "MoviPlayer — a WASM + WebCodecs video player custom element.\n\n" +
  "Plays formats the browser cannot (MKV, HEVC, AV1, TrueHD/DTS, …) on a WebGL2 " +
  "canvas, with adaptive quality, HDR, subtitles and a full built-in UI.";

/* 1. Custom Elements Manifest — read by VS Code (via this extension), WebStorm,
      Zed, and anything else that speaks CEM. */
const manifest = {
  schemaVersion: "2.0.0",
  readme: "README.md",
  modules: [
    {
      kind: "javascript-module",
      path: "dist/element.js",
      declarations: [
        {
          kind: "class",
          name: "MoviElement",
          tagName: "movi-player",
          customElement: true,
          description: TAG_DESCRIPTION,
          attributes: attributes.map((a) => ({
            name: a.name,
            description: a.description,
            ...(a.values.length
              ? { type: { text: a.values.map((v) => `"${v.name}"`).join(" | ") } }
              : {}),
          })),
          events,
          slots,
          cssParts,
          cssProperties: cssProperties.map((p) => ({
            name: p.name,
            description: p.description,
          })),
        },
      ],
      exports: [
        {
          kind: "custom-element-definition",
          name: "movi-player",
          declaration: { name: "MoviElement", module: "dist/element.js" },
        },
      ],
    },
  ],
};

/* 2. VS Code HTML custom data. */
const htmlData = {
  version: 1.1,
  tags: [
    {
      name: "movi-player",
      description: { kind: "markdown", value: TAG_DESCRIPTION },
      attributes: attributes.map((a) => ({
        name: a.name,
        description: { kind: "markdown", value: a.description },
        ...(a.values.length
          ? {
              values: a.values.map((v) => ({
                name: v.name,
                ...(v.description
                  ? { description: { kind: "markdown", value: stripMd(v.description) } }
                  : {}),
              })),
            }
          : {}),
        references: [{ name: "Documentation", url: `${DOCS_BASE}#${a.name}` }],
      })),
      references: [{ name: "Documentation", url: DOCS_BASE }],
    },
  ],
};

/* 3. VS Code CSS custom data — the --movi-* theming variables. */
const cssData = {
  version: 1.1,
  properties: cssProperties.map((p) => ({
    name: p.name,
    description: { kind: "markdown", value: p.description },
    references: [{ name: "Documentation", url: DOCS_BASE }],
  })),
};

const write = (rel, data) => {
  writeFileSync(join(ROOT, rel), JSON.stringify(data, null, 2) + "\n");
  return rel;
};

write("custom-elements.json", manifest);
write("vscode-extension/html-custom-data.json", htmlData);
write("vscode-extension/css-custom-data.json", cssData);

console.log(
  `[custom-data] movi-player v${PKG.version}: ` +
    `${attributes.length} attributes, ${cssParts.length} parts, ${slots.length} slots, ${cssProperties.length} CSS properties, ${events.length} events ` +
    `→ custom-elements.json + vscode-extension/{html,css}-custom-data.json`,
);
