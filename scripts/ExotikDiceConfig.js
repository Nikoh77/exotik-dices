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

/** Foundry v13+ deprecates the global FilePicker; use the namespaced class. */
const FP = foundry.applications.apps?.FilePicker ?? FilePicker;

const DICES_PATH = `modules/${MODULE_ID}/assets/dices`;
const DEFAULT_USER_DICES_PATH = `${MODULE_ID}/dices`;
const GEOMETRIES_PATH = `modules/${MODULE_ID}/assets/geometries`;

/** Runtime accessor for the user-configurable dice data path. */
function getUserDicePath() {
    try {
        return game.settings.get(MODULE_ID, "diceDataPath") || DEFAULT_USER_DICES_PATH;
    } catch {
        return DEFAULT_USER_DICES_PATH;
    }
}

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

/** Build the conventional asset base path (user data, outside modules/). */
function diceBasePath(slug) {
    return `${getUserDicePath()}/${slug}`;
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

/**
 * Delete a single file or empty directory on the Foundry server.
 *
 * Foundry VTT does not expose a public file-delete API.  Internally
 * FilePicker uses `_manageFiles` (socket-based) for browse / createDirectory.
 * We try the same mechanism with action "delete", falling back to HTTP
 * endpoints if available.
 *
 * @param {string} targetPath  Server-relative path
 * @returns {Promise<boolean>}
 */
export async function deleteServerPath(targetPath) {
    console.log(`${MODULE_ID} | deleteServerPath: ${targetPath}`);

    // ── Approach 1: FilePicker._manageFiles (socket-based, most reliable) ──
    if (typeof FP._manageFiles === "function") {
        for (const action of ["delete", "deleteFile", "removeFile"]) {
            try {
                await FP._manageFiles(
                    { source: "data", target: targetPath },
                    action,
                );
                console.log(`${MODULE_ID} | Deleted via _manageFiles("${action}"): ${targetPath}`);
                return true;
            } catch {
                // action not supported – try next
            }
        }
    }

    // ── Approach 2: HTTP DELETE to known Foundry routes ──
    const prefix =
        typeof window !== "undefined" && window.ROUTE_PREFIX
            ? `/${window.ROUTE_PREFIX}`
            : "";
    const urls = [`${prefix}/upload`, `${prefix}/api/files`];

    for (const url of urls) {
        try {
            const resp = await fetch(url, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ source: "data", path: targetPath }),
            });
            if (resp.ok) {
                console.log(`${MODULE_ID} | Deleted via HTTP DELETE ${url}: ${targetPath}`);
                return true;
            }
            console.log(`${MODULE_ID} | HTTP DELETE ${url} → ${resp.status}`);
        } catch {
            // endpoint not available
        }
    }

    console.warn(`${MODULE_ID} | Could not delete "${targetPath}" – no supported method found.`);
    return false;
}

/**
 * Recursively delete a folder and all its contents from the Foundry data dir.
 * Deletes files first, then sub-directories (depth-first), then the folder itself.
 * @param {string} folderPath  Server-relative path
 */
export async function deleteFolderRecursive(folderPath) {
    console.log(`${MODULE_ID} | deleteFolderRecursive: ${folderPath}`);
    let result;
    try {
        result = await FP.browse("data", folderPath);
    } catch {
        console.log(`${MODULE_ID} | Folder not found (browse failed): ${folderPath}`);
        return; // folder doesn't exist
    }

    console.log(
        `${MODULE_ID} | Found ${(result.files || []).length} files, ` +
        `${(result.dirs || []).length} sub-dirs in ${folderPath}`,
    );

    // Delete files in this directory
    for (const file of result.files || []) {
        await deleteServerPath(file);
    }

    // Recurse into subdirectories
    for (const dir of result.dirs || []) {
        await deleteFolderRecursive(dir);
    }

    // Delete the (now empty) folder itself
    await deleteServerPath(folderPath);
}

/** Create asset sub-folders for a dice on the server. */
async function ensureDiceFolders(slug) {
    const userPath = getUserDicePath();
    const base = `${userPath}/${slug}`;
    // Ensure intermediate directories exist
    const parts = userPath.split("/");
    const intermediateDirs = [];
    for (let i = 1; i <= parts.length; i++) {
        intermediateDirs.push(parts.slice(0, i).join("/"));
    }
    const dirs = [
        ...intermediateDirs,
        base,
        `${base}/textures`,
        `${base}/bump_maps`,
        `${base}/chat_2d`,
    ];
    for (const dir of dirs) {
        try {
            await FP.createDirectory("data", dir);
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
    const d = new Dialog({
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
    });
    d.render(true);
    // Bring to front after a tick so it appears above the settings window
    setTimeout(() => d.bringToTop?.(), 100);
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
            const result = await FP.browse("data", GEOMETRIES_PATH);
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

        // Preview data for the template (face count + denomination for DSN)
        const dsnGeoType = {
            4: "d4",
            6: "d6",
            8: "d8",
            10: "d10",
            12: "d12",
            20: "d20",
        };
        const previewDsnType = dsnGeoType[faceCount] || "d6";

        return {
            editing: true,
            dice: d,
            faces,
            facesOptions,
            geometryOptions,
            showGeometry,
            previewDsnType,
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

            // Geometry dropdown change → refresh 3D preview
            el.querySelector('[name="geometry"]')?.addEventListener(
                "change",
                () => this._refreshDSNPreview(),
            );

            // Live image previews
            el.querySelectorAll("input.image").forEach((input) => {
                input.addEventListener("change", (e) => this._onImageChange(e));
            });

            // Dirty tracking on all inputs
            el.addEventListener("input", () => this._checkDirty(el));
            el.addEventListener("change", () => this._checkDirty(el));

            // Initialize DSN 3D preview
            this._initDSNPreview(el);
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
            const possiblePaths = [
                `${getUserDicePath()}/${dice.slug}`,
                `${DICES_PATH}/${dice.slug}`,
            ];
            for (const folderPath of possiblePaths) {
                await deleteFolderRecursive(folderPath);
                console.log(`${MODULE_ID} | Deleted asset folder: ${folderPath}`);
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

        // Refresh DSN 3D preview when texture or bump changes
        const fieldName = input.name;
        if (fieldName && (fieldName.includes(".texture") || fieldName.includes(".bump"))) {
            this._refreshDSNPreview();
        }
    }

    /* ── DSN 3D Preview ── */

    /**
     * Initialize a Dice So Nice 3D preview in the editor.
     * Uses DSN's DiceBox in "showcase" mode with the module's DiceFactory.
     */
    async _initDSNPreview(el) {
        // Clean up any previous preview
        this._destroyDSNPreview();

        const container = el.querySelector(".ekd-3d-preview");
        if (!container) return;
        if (!game.dice3d?.box) {
            container.innerHTML = '<p class="notes" style="text-align:center;opacity:0.6;padding-top:110px;">Dice So Nice non disponibile</p>';
            return;
        }

        try {
            const DiceBox = game.dice3d.box.constructor;
            if (!DiceBox) return;

            // Create a canvas div for the preview
            const canvasDiv = document.createElement("div");
            canvasDiv.classList.add("ekd-3d-canvas");
            container.appendChild(canvasDiv);

            // Get DSN global config and override for our showcase
            const Dice3D = game.dice3d.constructor;
            const baseConfig = typeof Dice3D.ALL_CONFIG === "function"
                ? Dice3D.ALL_CONFIG()
                : (typeof Dice3D.CONFIG === "function" ? Dice3D.CONFIG() : {});
            const config = foundry.utils.mergeObject(baseConfig, {
                dimensions: { width: 260, height: 260 },
                autoscale: false,
                scale: 60,
                boxType: "showcase",
            });

            // Create a new DiceBox for preview, sharing the global DiceFactory
            const box = new DiceBox(canvasDiv, game.dice3d.DiceFactory, config);
            await box.initialize();

            this._previewBox = box;
            this._previewContainer = canvasDiv;

            // Boost lighting for better visibility
            if (box.scene) {
                // Increase all existing lights significantly
                const lights = [];
                box.scene.traverse((obj) => {
                    if (obj.isLight) {
                        obj.intensity *= 6;
                        lights.push(obj);
                    }
                });
                // Clone the brightest directional light and point it from the
                // opposite side so no face stays dark while rotating.
                const dirLight = lights.find((l) => l.isDirectionalLight);
                if (dirLight) {
                    const fill = dirLight.clone();
                    fill.position.set(
                        -dirLight.position.x,
                        dirLight.position.y * 0.5,
                        -dirLight.position.z,
                    );
                    fill.intensity = dirLight.intensity * 0.8;
                    box.scene.add(fill);

                    // Add a third light from below-front
                    const bottom = dirLight.clone();
                    bottom.position.set(0, -1, 1);
                    bottom.intensity = dirLight.intensity * 0.4;
                    box.scene.add(bottom);
                }
            }

            // Build and show the die
            await this._renderPreviewDie();

            // Start rotation animation
            this._startPreviewAnimation();
        } catch (err) {
            console.warn(`${MODULE_ID} | DSN 3D preview init failed:`, err);
            container.innerHTML = '<p class="notes" style="text-align:center;opacity:0.6;padding-top:110px;">Preview 3D non disponibile</p>';
        }
    }

    /**
     * Render (or re-render) the preview die mesh using current face textures.
     *
     * We bypass dice3d.addDicePreset() because it crashes on custom
     * denominations that aren't registered in CONFIG.Dice.terms.
     * Instead we manually create a DicePreset, register it in the factory,
     * and call factory.create() with a fully-populated appearance object.
     */
    async _renderPreviewDie() {
        if (!this._previewBox || !this._editingDice) return;

        const box = this._previewBox;
        const d = this._editingDice;
        const faceCount = d.faces || 6;
        const geoMap = { 4: "d4", 6: "d6", 8: "d8", 10: "d10", 12: "d12", 20: "d20" };
        const dsnGeo = geoMap[faceCount] || "d6";

        // Build labels and bumps from current faceMap
        const labels = d.faceMap.map((_, i) => {
            const r = resolveFace(d.faceMap, i);
            return r?.texture || "";
        });
        const bumpMaps = d.faceMap.map((_, i) => {
            const r = resolveFace(d.faceMap, i);
            return r?.bump || "";
        });

        try {
            const factory = game.dice3d.DiceFactory;

            // Remove old mesh and dispose its materials
            if (this._previewMesh && box.scene) {
                box.scene.remove(this._previewMesh);
                this._previewMesh.traverse?.((child) => {
                    if (child.isMesh) {
                        child.geometry?.dispose();
                        if (Array.isArray(child.material)) {
                            child.material.forEach((m) => {
                                m.map?.dispose();
                                m.bumpMap?.dispose();
                                m.dispose();
                            });
                        } else if (child.material) {
                            child.material.map?.dispose();
                            child.material.bumpMap?.dispose();
                            child.material.dispose();
                        }
                    }
                });
                this._previewMesh = null;
            }

            // ── Ensure preview system exists (hidden from DSN dropdown) ──
            const previewSystem = "ekd-preview";
            if (!factory.systems.has(previewSystem)) {
                factory.addSystem(
                    { id: previewSystem, name: "EKD Preview" },
                    false,
                );
            }

            // Clear any previous preview preset from the system
            factory.systems.get(previewSystem)?.dice.clear();

            // ── Get the standard model for this shape (d4/d6/d8/…) ──
            const standardModel = factory.systems
                .get("standard")
                .dice.get(dsnGeo);
            if (!standardModel) return;

            // ── Build and register a DicePreset ──
            // Use the real DSN type (d4/d6/d8…) so factory.create picks
            // the correct geometry builder for that shape.
            const DicePreset = standardModel.constructor;
            const preset = new DicePreset(dsnGeo, standardModel.shape);
            preset.term = "Die";
            preset.setLabels(labels);
            if (bumpMaps.some((b) => b)) preset.setBumpMaps(bumpMaps);
            preset.values = standardModel.values;
            preset.valueMap = standardModel.valueMap;
            preset.mass = standardModel.mass;
            preset.scale = standardModel.scale;
            preset.inertia = standardModel.inertia;
            preset.system = previewSystem;

            // Register ONLY in the preview system (not "standard") to
            // avoid side-effects on real dice.
            factory.systems.get(previewSystem).dice.set(dsnGeo, preset);

            // Load textures on the preset (images must be ready before create)
            await preset.loadTextures();

            // ── Build a complete appearance object ──
            const appearance = {
                system: previewSystem,
                colorset: "custom",
                foreground: "#FFFFFF",
                background: "#3a3a5e",
                outline: "#555",
                edge: "",
                texture: "none",
                material: "pristine",
                font: "Arial",
                fontScale: null,
                systemSettings: {},
                isGhost: false,
            };

            // scopedTextureCache expected by factory.create
            const scopedCache = box.dicePrediction ||
                box.scopedTextureCache || {
                    type: "showcase",
                    textureCube: box.textureCube ?? null,
                };
            if (!scopedCache.type) scopedCache.type = "showcase";

            const mesh = await factory.create(scopedCache, dsnGeo, appearance);

            if (mesh) {
                mesh.position.set(0, 0, 0);
                mesh.castShadow = false;
                mesh.receiveShadow = false;

                // ── Apply custom geometry if configured ──
                if (d.geometry && d.geometry !== "standard") {
                    await this._applyCustomGeometry(mesh, d.geometry);
                }

                box.scene?.add(mesh);
                this._previewMesh = mesh;
                if (typeof box.renderScene === "function") box.renderScene();
            }
        } catch (err) {
            console.warn(`${MODULE_ID} | DSN preview render failed:`, err);
        }
    }

    /**
     * Load a custom GLB geometry and apply it to the preview mesh.
     */
    async _applyCustomGeometry(mesh, geoName) {
        const allGeos = ExotikDiceConfig._geometriesCache || [];
        const geo = allGeos.find((g) => g.value === geoName);
        if (!geo) return;

        const factory = game.dice3d?.DiceFactory;
        if (!factory?.loaderGLTF) return;

        return new Promise((resolve) => {
            factory.loaderGLTF.load(
                geo.file,
                (gltf) => {
                    let geometry = null;
                    gltf.scene.traverse((child) => {
                        if (child.isMesh && !geometry) geometry = child.geometry;
                    });
                    if (geometry) {
                        const s = 60 / 100;
                        const g = geometry.clone();
                        g.scale(s, s, s);
                        if (mesh.isMesh) {
                            mesh.geometry = g;
                        } else {
                            mesh.traverse((child) => {
                                if (child.isMesh) child.geometry = g;
                            });
                        }
                    }
                    resolve();
                },
                undefined,
                (err) => {
                    console.warn(
                        `${MODULE_ID} | Could not load custom geometry ${geoName}:`,
                        err,
                    );
                    resolve();
                },
            );
        });
    }

    /**
     * Start a smooth rotation animation for the preview die.
     */
    _startPreviewAnimation() {
        if (this._previewAnimFrame) {
            cancelAnimationFrame(this._previewAnimFrame);
        }

        const animate = () => {
            if (!this._previewBox || !this._previewMesh) return;
            this._previewMesh.rotation.y += 0.008;
            this._previewMesh.rotation.x += 0.003;
            this._previewBox.renderScene?.();
            this._previewAnimFrame = requestAnimationFrame(animate);
        };
        this._previewAnimFrame = requestAnimationFrame(animate);
    }

    /**
     * Refresh the 3D preview after a texture change (debounced).
     */
    _refreshDSNPreview() {
        if (this._previewRefreshTimer) clearTimeout(this._previewRefreshTimer);
        this._previewRefreshTimer = setTimeout(async () => {
            this._captureFormData();
            await this._renderPreviewDie();
            // Restart animation (it stops when the mesh is replaced)
            this._startPreviewAnimation();
        }, 300);
    }

    /**
     * Clean up the DSN preview resources.
     */
    _destroyDSNPreview() {
        if (this._previewAnimFrame) {
            cancelAnimationFrame(this._previewAnimFrame);
            this._previewAnimFrame = null;
        }
        if (this._previewRefreshTimer) {
            clearTimeout(this._previewRefreshTimer);
            this._previewRefreshTimer = null;
        }
        if (this._previewMesh && this._previewBox?.scene) {
            this._previewBox.scene.remove(this._previewMesh);
            this._previewMesh = null;
        }
        if (this._previewBox) {
            try {
                this._previewBox.dispose?.();
            } catch {}
            this._previewBox = null;
        }
        this._previewContainer = null;

        // Remove temporary preview presets from DSN factory
        try {
            const factory = game.dice3d?.DiceFactory;
            if (factory) {
                factory.systems.get("ekd-preview")?.dice.clear();
            }
        } catch {
            /* best effort */
        }
    }

    /** Override close to clean up the 3D preview. */
    async close(options) {
        this._destroyDSNPreview();
        return super.close(options);
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
        // Check against CONFIG.Dice.terms (Foundry core + other modules).
        // In v13 CONFIG.Dice.terms keys are class names, so we also check the
        // DENOMINATION static property on each registered class.
        const reservedDenoms = new Set();
        for (const [key, cls] of Object.entries(CONFIG.Dice.terms || {})) {
            // Add the key itself (covers v12 denomination keys)
            reservedDenoms.add(key);
            // Add the DENOMINATION property (covers v13 class-name keys)
            if (cls?.DENOMINATION) reservedDenoms.add(cls.DENOMINATION);
        }
        // Remove our own registered denominations so editing an existing dice
        // doesn't block itself
        for (const def of currentDefs) {
            reservedDenoms.delete(def.denomination);
            reservedDenoms.delete(`ExotikDice_${def.denomination}`);
        }
        if (reservedDenoms.has(denom)) {
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
            const basePath = `${getUserDicePath()}/${diceDef.slug}`;
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
                        const result = await FP.upload("data", targetDir, file, {});
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
