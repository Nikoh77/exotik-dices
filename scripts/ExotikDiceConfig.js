/**
 * ExotikDiceConfig – Configuration window for Exotik Dices.
 * Handles the dice editor with face references, dirty tracking,
 * dynamic geometry discovery, and 3D CSS preview.
 *
 * Two entry points:
 *  1. registerMenu fallback → list view
 *  2. ExotikDiceConfig.editDice() → editor (used by settings injection)
 */

const MODULE_ID = "exotik-dices";
const DICES_PATH = `modules/${MODULE_ID}/assets/dices`;
const GEOMETRIES_PATH = `modules/${MODULE_ID}/assets/geometries`;

/** Supported face counts */
const FACE_OPTIONS = [4, 6, 8, 10, 12, 20];

/* ─── Utility functions ─── */

/** Convert a dice name to a filesystem-safe slug. */
function nameToSlug(name) {
    return (name || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
}

/** Build the conventional asset base path. */
function diceBasePath(slug) {
    return `${DICES_PATH}/${slug}`;
}

/**
 * Resolve a face reference chain to the actual face.
 * Returns the resolved face object or null if loop/invalid.
 */
export function resolveFace(faceMap, index, visited = new Set()) {
    if (index == null || index < 0 || index >= faceMap.length) return null;
    const face = faceMap[index];
    if (!face) return null;
    if (face.refFace == null) return face;
    if (visited.has(index)) return null;
    visited.add(index);
    return resolveFace(faceMap, face.refFace, visited);
}

/**
 * Would setting faceMap[fromIdx].refFace = toIdx create a loop?
 */
function wouldCreateLoop(faceMap, faceCount, fromIdx, toIdx) {
    const visited = new Set();
    let current = toIdx;
    while (current != null) {
        if (current === fromIdx) return true;
        if (visited.has(current)) return false;
        if (current < 0 || current >= faceCount) return false;
        visited.add(current);
        current = faceMap[current]?.refFace ?? null;
    }
    return false;
}

/** Create asset sub-folders for a dice on the server. */
async function ensureDiceFolders(slug) {
    const base = `assets/dices/${slug}`;
    const dirs = [
        base,
        `${base}/textures`,
        `${base}/bump_maps`,
        `${base}/chat_2d`,
    ];
    for (const dir of dirs) {
        try {
            await FilePicker.createDirectory(
                "data",
                `modules/${MODULE_ID}/${dir}`,
            );
        } catch (e) {
            if (
                !e.message?.includes("EEXIST") &&
                !e.message?.includes("already exists")
            ) {
                console.warn(
                    `${MODULE_ID} | Could not create folder ${dir}:`,
                    e.message,
                );
            }
        }
    }
}

/* ─── Exported helpers ─── */

/** Show the reload-world dialog. */
export function promptReload() {
    new Dialog({
        title: game.i18n.localize("EKD.Config.ReloadRequired"),
        content: `<p>${game.i18n.localize("EKD.Config.ReloadRequiredMsg")}</p>`,
        buttons: {
            reload: {
                icon: '<i class="fas fa-sync"></i>',
                label: game.i18n.localize("EKD.Config.ReloadNow"),
                callback: () => window.location.reload(),
            },
            later: {
                icon: '<i class="fas fa-clock"></i>',
                label: game.i18n.localize("EKD.Config.ReloadLater"),
            },
        },
        default: "reload",
    }).render(true);
}

/** Simple markdown → HTML for README display. */
export function markdownToHtml(md) {
    return md
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
        .replace(/^### (.+)$/gm, "<h3>$1</h3>")
        .replace(/^## (.+)$/gm, "<h2>$1</h2>")
        .replace(/^# (.+)$/gm, "<h1>$1</h1>")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/```[\s\S]*?```/g, (m) => {
            const inner = m.replace(/```\w*\n?/, "").replace(/```$/, "");
            return `<pre><code>${inner}</code></pre>`;
        })
        .replace(/^\- (.+)$/gm, "<li>$1</li>")
        .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
        .replace(/((?:<li>.*<\/li>\s*)+)/g, "<ul>$1</ul>")
        .replace(/\n{2,}/g, "<br>");
}

/* ═══════════════════════════════════════════════ */
/*  ExotikDiceConfig FormApplication              */
/* ═══════════════════════════════════════════════ */

export class ExotikDiceConfig extends FormApplication {
    /** @type {Array|null} Cached custom geometry scan results. */
    static _geometriesCache = null;

    constructor(object = {}, options = {}) {
        super(object, options);
        /** null = list view; object = editing that dice. */
        this._editingDice = null;
        /** Reference to the SettingsConfig app (for refresh after save). */
        this._settingsApp = null;
        /** Serialized form data at render time (for dirty tracking). */
        this._originalSnapshot = null;
    }

    /* ── Geometry scanning ── */

    /**
     * Scan the geometries folder for .glb files.
     * Filename convention: *_d{N}.glb → N is face count.
     */
    static async scanGeometries() {
        if (ExotikDiceConfig._geometriesCache)
            return ExotikDiceConfig._geometriesCache;
        try {
            const result = await FilePicker.browse("data", GEOMETRIES_PATH);
            const geos = [];
            for (const fp of result.files || []) {
                if (!fp.endsWith(".glb")) continue;
                const filename = fp.split("/").pop().replace(".glb", "");
                const m = filename.match(/_d(\d+)/);
                if (!m) continue;
                geos.push({
                    file: fp,
                    faces: parseInt(m[1]),
                    name: filename
                        .replace(/_d\d+$/, "")
                        .replace(/_/g, " ")
                        .replace(/\b\w/g, (c) => c.toUpperCase()),
                    value: filename,
                });
            }
            ExotikDiceConfig._geometriesCache = geos;
            return geos;
        } catch (e) {
            console.warn(`${MODULE_ID} | scanGeometries:`, e);
            return [];
        }
    }

    /* ── Static entry point ── */

    /**
     * Open the editor for a dice definition (or new dice).
     * @param {object|null} dice   Existing dice def, or null for new
     * @param {Application|null} settingsApp  SettingsConfig to refresh on save
     */
    static editDice(dice = null, settingsApp = null) {
        const config = new ExotikDiceConfig();
        config._settingsApp = settingsApp;
        if (dice) {
            config._editingDice = foundry.utils.deepClone(dice);
        } else {
            config._editingDice = {
                id: foundry.utils.randomID(),
                name: "",
                slug: "",
                denomination: "",
                faces: 6,
                geometry: "standard",
                faceMap: Array.from({ length: 6 }, () => ({
                    refFace: null,
                    label: "",
                    texture: "",
                    bump: "",
                    icon: "",
                })),
            };
        }
        config.render(true);
    }

    /* ── FormApplication overrides ── */

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "ekd-dice-config",
            template: `modules/${MODULE_ID}/templates/dice-config.hbs`,
            width: 640,
            height: "auto",
            closeOnSubmit: false,
            submitOnChange: false,
            resizable: true,
            classes: ["ekd-config"],
        });
    }

    get title() {
        if (this._editingDice) {
            return this._editingDice.name
                ? game.i18n.format("EKD.Editor.TitleEdit", {
                      name: this._editingDice.name,
                  })
                : game.i18n.localize("EKD.Editor.TitleNew");
        }
        return game.i18n.localize("EKD.Config.Title");
    }

    /** Scan geometries before every render. */
    async _render(force, options) {
        if (!ExotikDiceConfig._geometriesCache) {
            await ExotikDiceConfig.scanGeometries();
        }
        return super._render(force, options);
    }

    /* ── Data for Handlebars ── */

    getData() {
        return this._editingDice ? this._getEditorData() : this._getListData();
    }

    _getEditorData() {
        const d = this._editingDice;
        const faceCount = d.faces || 6;
        const faceMap = d.faceMap || [];

        // Build face entries with reference info
        const faces = [];
        for (let i = 0; i < faceCount; i++) {
            const fm = faceMap[i] || {};
            const currentRef = fm.refFace ?? null;
            const isRef = currentRef != null;

            // Allowed reference targets (exclude self + loop-causing)
            const allowedRefs = [];
            for (let j = 0; j < faceCount; j++) {
                if (j === i) continue;
                if (wouldCreateLoop(faceMap, faceCount, i, j)) continue;
                allowedRefs.push({
                    value: j,
                    label: String(j + 1),
                    selected: currentRef === j,
                });
            }

            faces.push({
                number: i + 1,
                index: i,
                label: fm.label ?? "",
                texture: fm.texture ?? "",
                bump: fm.bump ?? "",
                icon: fm.icon ?? "",
                refFace: currentRef,
                isRef,
                refLabel: isRef ? String(currentRef + 1) : "",
                allowedRefs,
            });
        }

        // Face count options
        const facesOptions = FACE_OPTIONS.map((n) => ({
            value: n,
            label: String(n),
            selected: n === faceCount,
        }));

        // Geometry options – from scanned .glb files
        const allGeos = ExotikDiceConfig._geometriesCache || [];
        const customGeos = allGeos.filter((g) => g.faces === faceCount);
        const showGeometry = customGeos.length > 0;
        const geometryOptions = showGeometry
            ? [
                  {
                      value: "standard",
                      label: game.i18n.localize("EKD.Editor.GeometryStandard"),
                      selected: d.geometry === "standard",
                  },
                  ...customGeos.map((g) => ({
                      value: g.value,
                      label: g.name,
                      selected: d.geometry === g.value,
                  })),
              ]
            : [];

        // CSS 3D cube preview (d6) – always shown
        let previewFaces = null;
        let showCubePreview = false;
        if (faceCount === 6) {
            previewFaces = [];
            for (let i = 0; i < 6; i++) {
                const resolved = resolveFace(faceMap, i);
                previewFaces.push(resolved?.texture || "");
            }
            showCubePreview = true;
        }

        // Flat face strip preview (all face counts except d6)
        const previewStrip = [];
        for (let i = 0; i < faceCount; i++) {
            const resolved = resolveFace(faceMap, i);
            previewStrip.push({ texture: resolved?.texture || "", num: i + 1 });
        }
        const showStripPreview = faceCount !== 6;

        return {
            editing: true,
            dice: d,
            faces,
            facesOptions,
            geometryOptions,
            showGeometry,
            showCubePreview,
            previewFaces,
            showStripPreview,
            previewStrip,
            faceCount,
            slug: d.slug || "",
            assetHint: d.slug
                ? `${diceBasePath(d.slug)}/textures/,  …/bump_maps/,  …/chat_2d/`
                : "",
        };
    }

    _getListData() {
        const definitions =
            game.settings.get(MODULE_ID, "diceDefinitions") || [];
        const allGeos = ExotikDiceConfig._geometriesCache || [];
        const diceList = definitions.map((d) => {
            const geo = allGeos.find((g) => g.value === d.geometry);
            return {
                ...d,
                isDefault: d.id === "ekd-default-combat",
                geometryLabel: geo
                    ? geo.name
                    : game.i18n.localize("EKD.Editor.GeometryStandard"),
            };
        });
        return { editing: false, diceList };
    }

    /* ── Listeners ── */

    activateListeners(html) {
        super.activateListeners(html);
        const el = html instanceof HTMLElement ? html : (html?.[0] ?? html);
        if (!el) return;

        // Delegated click handler
        el.addEventListener("click", (event) => {
            const t = event.target;
            if (t.closest(".ekd-add-dice")) {
                event.preventDefault();
                event.stopPropagation();
                return this._onAddDice(event);
            }
            if (t.closest(".ekd-edit")) {
                event.preventDefault();
                event.stopPropagation();
                return this._onEditDice(event);
            }
            if (t.closest(".ekd-delete")) {
                event.preventDefault();
                event.stopPropagation();
                return this._onDeleteDice(event);
            }
            if (t.closest(".ekd-back")) {
                event.preventDefault();
                event.stopPropagation();
                if (this._settingsApp) {
                    this.close();
                } else {
                    this._editingDice = null;
                    setTimeout(() => this.render(true), 0);
                }
            }
        });

        if (this._editingDice) {
            // Snapshot for dirty tracking (only on first render of edit session)
            if (!this._originalSnapshot) {
                this._originalSnapshot = JSON.stringify(this._getSubmitData());
            }

            // Faces count change → resize faceMap + re-render
            el.querySelector('[name="faces"]')?.addEventListener(
                "change",
                (e) => {
                    this._captureFormData();
                    this._editingDice.faces = parseInt(e.target.value);
                    if (this._editingDice.faces !== 6)
                        this._editingDice.geometry = "standard";
                    const newLen = this._editingDice.faces;
                    while (this._editingDice.faceMap.length < newLen) {
                        this._editingDice.faceMap.push({
                            refFace: null,
                            label: "",
                            texture: "",
                            bump: "",
                            icon: "",
                        });
                    }
                    this._editingDice.faceMap.length = newLen;
                    setTimeout(() => this.render(true), 0);
                },
            );

            // Reference dropdown change → re-render
            el.querySelectorAll(".ekd-ref-select").forEach((sel) => {
                sel.addEventListener("change", () => {
                    this._captureFormData();
                    setTimeout(() => this.render(true), 0);
                });
            });

            // Live image previews
            el.querySelectorAll("input.image").forEach((input) => {
                input.addEventListener("change", (e) => this._onImageChange(e));
            });

            // Dirty tracking on all inputs
            el.addEventListener("input", () => this._checkDirty(el));
            el.addEventListener("change", () => this._checkDirty(el));
        }
    }

    /* ── Dirty tracking ── */

    _checkDirty(el) {
        try {
            const current = JSON.stringify(this._getSubmitData());
            const isDirty = current !== this._originalSnapshot;
            const btn = el?.querySelector?.(".ekd-save-btn");
            if (btn) btn.disabled = !isDirty;
        } catch {
            /* ignore */
        }
    }

    /* ── List mode handlers ── */

    _onAddDice(event) {
        event.preventDefault();
        this._originalSnapshot = null;
        this._editingDice = {
            id: foundry.utils.randomID(),
            name: "",
            slug: "",
            denomination: "",
            faces: 6,
            geometry: "standard",
            faceMap: Array.from({ length: 6 }, () => ({
                refFace: null,
                label: "",
                texture: "",
                bump: "",
                icon: "",
            })),
        };
        setTimeout(() => this.render(true), 0);
    }

    _onEditDice(event) {
        event.preventDefault();
        const id = event.target.closest("[data-id]")?.dataset?.id;
        if (!id) return;
        const defs = game.settings.get(MODULE_ID, "diceDefinitions") || [];
        const dice = defs.find((d) => d.id === id);
        if (!dice) return;
        if (dice.id === "ekd-default-combat") {
            ui.notifications.warn(
                game.i18n.localize("EKD.Config.DefaultProtected"),
            );
            return;
        }
        this._originalSnapshot = null;
        this._editingDice = foundry.utils.deepClone(dice);
        setTimeout(() => this.render(true), 0);
    }

    async _onDeleteDice(event) {
        event.preventDefault();
        const id = event.target.closest("[data-id]")?.dataset?.id;
        if (!id) return;
        const defs = game.settings.get(MODULE_ID, "diceDefinitions") || [];
        const dice = defs.find((d) => d.id === id);
        if (!dice) return;
        if (dice.id === "ekd-default-combat") {
            ui.notifications.warn(game.i18n.localize("EKD.Config.DefaultProtected"));
            return;
        }
        const confirmed = await Dialog.confirm({
            title: game.i18n.localize("EKD.Config.Delete"),
            content: `<p>${game.i18n.format("EKD.Config.DeleteConfirm", { name: dice.name })}</p>`,
        });
        if (!confirmed) return;
        const updated = defs.filter((d) => d.id !== id);
        await game.settings.set(MODULE_ID, "diceDefinitions", updated);
        // Try to remove the dice asset folder
        if (dice.slug) {
            try {
                const folderPath = `${DICES_PATH}/${dice.slug}`;
                await FilePicker.browse("data", folderPath).then(async (result) => {
                    for (const file of result.files || []) {
                        try { await fetch(window.location.origin + "/api/files", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: file, source: "data" }) }); } catch {}
                    }
                    for (const dir of result.dirs || []) {
                        try {
                            const sub = await FilePicker.browse("data", dir);
                            for (const f of sub.files || []) {
                                try { await fetch(window.location.origin + "/api/files", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: f, source: "data" }) }); } catch {}
                            }
                        } catch {}
                    }
                });
                console.log(`${MODULE_ID} | Deleted asset folder: ${folderPath}`);
            } catch (err) {
                console.warn(`${MODULE_ID} | Could not delete asset folder for "${dice.name}":`, err);
            }
        }
        this.render(true);
        promptReload();
    }

    /* ── Editor mode handlers ── */

    _onImageChange(event) {
        const input = event.currentTarget;
        const preview = input
            .closest(".form-group")
            ?.querySelector(".ekd-face-preview");
        if (!preview) return;
        if (input.value) {
            preview.src = input.value;
            preview.style.display = "";
        } else {
            preview.style.display = "none";
        }
    }

    /* ── Persistence ── */

    async _updateObject(_event, formData) {
        if (!this._editingDice) return;

        const expanded = foundry.utils.expandObject(formData);
        const currentDefs =
            game.settings.get(MODULE_ID, "diceDefinitions") || [];

        // ── Name validation ──
        const nameTrimmed = (expanded.name ?? "").trim();
        if (!nameTrimmed) {
            ui.notifications.error(
                game.i18n.localize("EKD.Validation.NameRequired"),
            );
            throw new Error("Validation failed");
        }
        const nameConflict = currentDefs.find(
            (d) =>
                d.name.trim().toLowerCase() === nameTrimmed.toLowerCase() &&
                d.id !== this._editingDice.id,
        );
        if (nameConflict) {
            ui.notifications.error(
                game.i18n.format("EKD.Validation.NameConflict", {
                    name: nameConflict.name,
                }),
            );
            throw new Error("Validation failed");
        }

        // ── Denomination validation ──
        const denom = (expanded.denomination ?? "").trim().toLowerCase();
        if (!denom) {
            ui.notifications.error(
                game.i18n.localize("EKD.Validation.DenominationRequired"),
            );
            throw new Error("Validation failed");
        }
        if (denom.length !== 1) {
            ui.notifications.error(
                game.i18n.localize("EKD.Validation.DenominationLength"),
            );
            throw new Error("Validation failed");
        }
        // Check against CONFIG.Dice.terms (Foundry core + other modules)
        const externalTerms = new Set(Object.keys(CONFIG.Dice.terms || {}));
        for (const def of currentDefs) externalTerms.delete(def.denomination);
        if (externalTerms.has(denom)) {
            ui.notifications.error(
                game.i18n.format("EKD.Validation.DenominationReserved", {
                    denom,
                }),
            );
            throw new Error("Validation failed");
        }
        // Check against our own dice
        const denomConflict = currentDefs.find(
            (d) => d.denomination === denom && d.id !== this._editingDice.id,
        );
        if (denomConflict) {
            ui.notifications.error(
                game.i18n.format("EKD.Validation.DenominationConflict", {
                    denom,
                    name: denomConflict.name,
                }),
            );
            throw new Error("Validation failed");
        }

        // ── Build faceMap ──
        const faceCount = parseInt(expanded.faces) || 6;
        const faceMap = [];
        const rawMap = expanded.faceMap || {};
        for (let i = 0; i < faceCount; i++) {
            const f = rawMap[i] || {};
            const refStr = String(f.refFace ?? "").trim();
            const refFace = refStr !== "" ? parseInt(refStr) : null;
            faceMap.push({
                refFace,
                label: refFace != null ? "" : (f.label ?? "").trim(),
                texture: refFace != null ? "" : (f.texture ?? "").trim(),
                bump: refFace != null ? "" : (f.bump ?? "").trim(),
                icon: refFace != null ? "" : (f.icon ?? "").trim(),
            });
        }

        // Validate no loops
        for (let i = 0; i < faceMap.length; i++) {
            if (faceMap[i].refFace != null && !resolveFace(faceMap, i)) {
                ui.notifications.error(
                    game.i18n.localize("EKD.Validation.FaceRefLoop"),
                );
                throw new Error("Validation failed");
            }
        }

        // ── Geometry ──
        const allGeos = ExotikDiceConfig._geometriesCache || [];
        const customGeos = allGeos.filter((g) => g.faces === faceCount);
        let geometry = "standard";
        if (customGeos.length > 0) {
            geometry = expanded.geometry || "standard";
        }

        const diceDef = {
            id: this._editingDice.id,
            name: nameTrimmed,
            slug: this._editingDice.slug || nameToSlug(nameTrimmed),
            denomination: denom,
            faces: faceCount,
            geometry,
            faceMap,
        };

        // ── Dirty check ──
        const existingIdx = currentDefs.findIndex((d) => d.id === diceDef.id);
        if (
            existingIdx >= 0 &&
            JSON.stringify(currentDefs[existingIdx]) === JSON.stringify(diceDef)
        ) {
            ui.notifications.info(
                game.i18n.localize("EKD.Validation.NoChanges"),
            );
            if (this._settingsApp) this.close();
            else {
                this._editingDice = null;
                setTimeout(() => this.render(true), 0);
            }
            return;
        }

        // ── Create folders ──
        if (diceDef.slug) await ensureDiceFolders(diceDef.slug);

        // ── Copy asset files into the dice folder ──
        if (diceDef.slug) {
            const basePath = `modules/${MODULE_ID}/assets/dices/${diceDef.slug}`;
            const subfolders = { texture: "textures", bump: "bump_maps", icon: "chat_2d" };

            for (let i = 0; i < diceDef.faceMap.length; i++) {
                const face = diceDef.faceMap[i];
                if (face.refFace != null) continue; // skip references

                for (const [field, subfolder] of Object.entries(subfolders)) {
                    const srcPath = face[field];
                    if (!srcPath) continue;

                    // Skip if already inside this dice's asset folder
                    if (srcPath.startsWith(basePath + "/")) continue;

                    try {
                        // Fetch the source file
                        const response = await fetch(srcPath);
                        if (!response.ok) continue;
                        const blob = await response.blob();

                        // Determine filename
                        const srcFilename = srcPath.split("/").pop();
                        const file = new File([blob], srcFilename, { type: blob.type });

                        // Upload to the target subfolder
                        const targetDir = `${basePath}/${subfolder}`;
                        const result = await FilePicker.upload("data", targetDir, file, {});
                        if (result?.path) {
                            face[field] = result.path;
                        }
                    } catch (err) {
                        console.warn(`${MODULE_ID} | Could not copy ${field} for face ${i}:`, err);
                    }
                }
            }
        }

        // ── Save ──
        if (existingIdx >= 0) currentDefs[existingIdx] = diceDef;
        else currentDefs.push(diceDef);
        await game.settings.set(MODULE_ID, "diceDefinitions", currentDefs);
        ui.notifications.info(
            game.i18n.format("EKD.Config.DiceSaved", { name: diceDef.name }),
        );

        // ── Post-save ──
        if (this._settingsApp) {
            this._settingsApp.render(true);
            this.close();
        } else {
            this._editingDice = null;
            this.render(true);
        }
        promptReload();
    }

    /* ── Helpers ── */

    _captureFormData() {
        const formData = this._getSubmitData();
        const exp = foundry.utils.expandObject(formData);
        this._editingDice.name = exp.name ?? this._editingDice.name;
        if (!this._editingDice.slug) {
            this._editingDice.slug = nameToSlug(this._editingDice.name);
        }
        this._editingDice.denomination =
            exp.denomination ?? this._editingDice.denomination;
        this._editingDice.geometry = exp.geometry ?? this._editingDice.geometry;
        if (exp.faceMap) {
            const newMap = [];
            const rawMap = exp.faceMap;
            for (let i = 0; i < this._editingDice.faces; i++) {
                const f = rawMap[i] || {};
                const refStr = String(f.refFace ?? "").trim();
                const refFace = refStr !== "" ? parseInt(refStr) : null;
                newMap.push({
                    refFace,
                    label: refFace != null ? "" : (f.label ?? "").trim(),
                    texture: refFace != null ? "" : (f.texture ?? "").trim(),
                    bump: refFace != null ? "" : (f.bump ?? "").trim(),
                    icon: refFace != null ? "" : (f.icon ?? "").trim(),
                });
            }
            this._editingDice.faceMap = newMap;
        }
    }
}
