const {
  ItemView,
  Keymap,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  debounce,
  setIcon,
} = require("obsidian");

// Pied de fiche :
// 🔄 Maj 17/10/2025 (GPT-5)
// 👁️ Lu 08/10/2026            ou   👁️ Lu partiellement 08/10/2026
const MAJ = /^🔄 Maj (\d{2})\/(\d{2})\/(\d{4})(?: \((.+)\))?\s*$/u;
const LU = /^\u{1F441}️? Lu( partiellement)? (\d{2})\/(\d{2})\/(\d{4})\s*$/u;
const EXCLUDED = new Set(["AGENTS.md"]);
const VIEW_TYPE = "date-maj-recents";
const DEFAULT_SETTINGS = { model: "Opus 5.5", newestFirst: false, mode: "maj", viewCreated: false };

const pad = (n) => String(n).padStart(2, "0");
const format = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const isTarget = (file) =>
  file instanceof TFile && file.extension === "md" && !EXCLUDED.has(file.path);

function parseFooter(text) {
  const lines = text.replace(/\s+$/, "").split("\n");
  let maj = null;
  let lu = null;
  while (lines.length > 0) {
    const line = lines[lines.length - 1];
    const m = !maj && line.match(MAJ);
    const l = !lu && line.match(LU);
    if (m) maj = { day: new Date(+m[3], +m[2] - 1, +m[1]).getTime(), model: m[4] || "" };
    else if (l) lu = { day: new Date(+l[4], +l[3] - 1, +l[2]).getTime(), partial: !!l[1] };
    else break;
    lines.pop();
  }
  return { base: lines.join("\n").replace(/\s+$/, ""), maj, lu };
}

function composeFooter({ base, maj, lu }) {
  const footer = [];
  if (maj) footer.push(`🔄 Maj ${format(new Date(maj.day))}${maj.model ? ` (${maj.model})` : ""}`);
  if (lu) footer.push(`👁️ Lu ${lu.partial ? "partiellement " : ""}${format(new Date(lu.day))}`);
  if (footer.length === 0) return `${base}\n`;
  return `${base ? `${base}\n\n` : ""}${footer.join("\n")}\n`;
}

// Marque de lecture d'un passage, en exposant en fin de ligne : <sup class="lu">👁️ 08/10/2026</sup>
const PASSAGE = / ?<sup class="lu">👁️ \d{2}\/\d{2}\/\d{4}<\/sup>/u;
const BLOCK_ID = /(\s\^[A-Za-z0-9-]+)$/;

// Renvoie le texte modifié, ou un message d'erreur (string commençant par "!")
function markPassage(text, n, date) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const line = lines[n];
  if (line === undefined || !line.trim()) return "!Ligne vide";
  if (/^#{1,6}\s/.test(line)) return "!Pas sur un titre (les liens vers les titres casseraient)";
  if (/^\s*\|/.test(line)) return "!Pas dans un tableau";
  if (MAJ.test(line) || LU.test(line)) return "!Pas sur le pied de dates";
  const fences = lines.slice(0, n).filter((l) => /^\s*(```|~~~)/.test(l)).length;
  if (fences % 2 === 1 || /^\s*(```|~~~)/.test(line)) return "!Pas dans un bloc de code";
  let next = line.replace(PASSAGE, "");
  if (date) {
    const mark = ` <sup class="lu">👁️ ${date}</sup>`;
    next = BLOCK_ID.test(next) ? next.replace(BLOCK_ID, `${mark}$1`) : next.replace(/\s*$/, mark);
  }
  lines[n] = next;
  return lines.join(eol);
}

const todayDay = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

class RecentsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.requestRender = debounce(() => this.render(), 200, true);
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Par date";
  }

  getIcon() {
    return "history";
  }

  async onOpen() {
    this.contentEl.addClass("date-maj-recents");
    this.registerEvent(this.app.workspace.on("file-open", () => this.highlight()));
    this.render();
  }

  button(parent, icon, label, onClick) {
    const el = parent.createDiv("clickable-icon nav-action-button");
    setIcon(el, icon);
    el.setAttr("aria-label", label);
    el.onClickEvent(onClick);
    return el;
  }

  render() {
    const { plugin } = this;
    const { settings } = plugin;
    const el = this.contentEl;
    el.empty();

    const buttons = el.createDiv("nav-header").createDiv("nav-buttons-container");
    const maj = settings.mode === "maj";
    this.button(buttons, maj ? "refresh-cw" : "book-open-check",
      maj ? "Dates de mise à jour (cliquer pour les dates de lecture)" : "Dates de lecture (cliquer pour les dates de mise à jour)",
      () => plugin.updateSettings({ mode: maj ? "lu" : "maj" }));
    this.button(buttons, settings.newestFirst ? "arrow-down-wide-narrow" : "arrow-up-narrow-wide",
      settings.newestFirst ? "Plus récent en haut" : "Plus ancien en haut",
      () => plugin.updateSettings({ newestFirst: !settings.newestFirst }));

    const list = el.createDiv("date-maj-list");
    this.rows = new Map();
    for (const entry of plugin.sortedEntries()) {
      const row = list.createDiv("tree-item-self is-clickable date-maj-row");
      row.createSpan({ cls: "date-maj-date", text: format(new Date(entry.day)) });
      row.createSpan({ cls: "date-maj-name", text: entry.file.basename });
      if (entry.partial) row.createSpan({ cls: "date-maj-tag", text: "partiel" });
      row.setAttr("aria-label", entry.file.path);
      row.setAttr("data-tooltip-position", "right");
      row.addEventListener("click", (evt) => {
        this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(entry.file);
      });
      row.addEventListener("auxclick", (evt) => {
        if (evt.button === 1) this.app.workspace.getLeaf("tab").openFile(entry.file);
      });
      row.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        const menu = new Menu();
        this.app.workspace.trigger("file-menu", menu, entry.file, "date-maj-view");
        menu.showAtMouseEvent(evt);
      });
      this.rows.set(entry.file.path, row);
    }
    this.highlight();
  }

  highlight() {
    if (!this.rows) return;
    const active = this.app.workspace.getActiveFile();
    for (const [path, row] of this.rows) row.toggleClass("is-active", !!active && active.path === path);
  }
}

class DateMajSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Modèle indiqué avec la date Maj")
      .setDesc("Ajouté entre parenthèses par le bouton « Mise à jour ». Laisser vide pour ne rien ajouter.")
      .addText((text) =>
        text.setValue(this.plugin.settings.model).onChange((value) => this.plugin.updateSettings({ model: value.trim() }))
      );
  }
}

module.exports = class DateMaj extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.footers = new Map();
    this.viewsWithActions = new WeakSet();

    // Boutons dans l'en-tête des notes
    this.app.workspace.onLayoutReady(() => this.addNoteActions());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.addNoteActions()));

    const commands = [
      ["marquer-maj", "Marquer comme mise à jour", "maj"],
      ["marquer-lu", "Marquer comme lue", "lu"],
      ["marquer-lu-partiel", "Marquer comme lue partiellement", "partiel"],
    ];
    for (const [id, name, kind] of commands) {
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (!view || !isTarget(view.file)) return false;
          if (!checking) this.mark(view.file, kind);
          return true;
        },
      });
    }

    // Clic droit sur une note (explorateur, vue par date, menu de la note)
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!isTarget(file) || !this.footers.get(file.path)?.maj) return;
        menu.addItem((item) =>
          item
            .setTitle("Marquer lue à la date de mise à jour")
            .setIcon("calendar-check")
            .setSection("action")
            .onClick(() => this.mark(file, "lu-maj"))
        );
      })
    );

    // Marque de lecture d'un passage : clic droit en édition et en lecture
    this.sectionContexts = new WeakMap();
    this.registerMarkdownPostProcessor((el, ctx) => this.sectionContexts.set(el, ctx));
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        if (!isTarget(view.file)) return;
        const n = editor.getCursor("to").line;
        this.addPassageItems(menu, view.file, n, editor.getLine(n));
      })
    );
    this.registerDomEvent(document, "contextmenu", (evt) => this.onReadingContextMenu(evt));
    this.addCommand({
      id: "marquer-passage-lu",
      name: "Marquer le passage comme lu",
      editorCheckCallback: (checking, editor, view) => {
        if (!isTarget(view.file)) return false;
        if (!checking) this.markPassage(view.file, editor.getCursor("to").line, true);
        return true;
      },
    });

    // Vue « par date »
    this.registerView(VIEW_TYPE, (leaf) => new RecentsView(leaf, this));
    this.addRibbonIcon("history", "Notes par date", () => this.revealView());
    this.addCommand({ id: "ouvrir-vue", name: "Afficher les notes par date", callback: () => this.revealView() });
    this.addSettingTab(new DateMajSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      // Après le chargement : Obsidian émet un « create » par fichier au démarrage
      this.registerEvent(this.app.vault.on("modify", (file) => this.index(file)));
      this.registerEvent(this.app.vault.on("create", (file) => this.index(file)));
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          if (this.footers.delete(file.path)) this.refreshViews();
        })
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          this.footers.delete(oldPath);
          this.index(file);
        })
      );

      await Promise.all(this.app.vault.getMarkdownFiles().map((f) => this.index(f, false)));
      // Onglet créé une seule fois à gauche ; si tu le fermes, l'icône du ruban le rouvre
      if (!this.settings.viewCreated) {
        if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length === 0) {
          await this.app.workspace.getLeftLeaf(false).setViewState({ type: VIEW_TYPE, active: false });
        }
        await this.updateSettings({ viewCreated: true });
      }
      this.refreshViews();
    });
  }

  onunload() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      leaf.view.actionsEl?.querySelectorAll(".date-maj-action").forEach((el) => el.remove());
    }
  }

  async updateSettings(patch) {
    Object.assign(this.settings, patch);
    await this.saveData(this.settings);
    this.refreshViews(true);
  }

  // ---------- Boutons Maj / Lu ----------

  addNoteActions() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || this.viewsWithActions.has(view)) continue;
      // addAction insère à gauche : ordre affiché Maj, Lu partiellement, Lu
      view.addAction("book-open-check", "Marquer comme lue", () => this.mark(view.file, "lu")).addClass("date-maj-action");
      view.addAction("book-open", "Marquer comme lue partiellement", () => this.mark(view.file, "partiel")).addClass("date-maj-action");
      view.addAction("refresh-cw", "Marquer comme mise à jour", () => this.mark(view.file, "maj")).addClass("date-maj-action");
      this.viewsWithActions.add(view);
    }
  }

  async mark(file, kind) {
    if (!isTarget(file)) return;
    let day = todayDay();
    const transform = (text) => {
      const footer = parseFooter(text);
      if (kind === "maj") footer.maj = { day, model: this.settings.model };
      else if (kind === "lu-maj") {
        if (!footer.maj) return text;
        day = footer.maj.day;
        footer.lu = { day, partial: false };
      } else footer.lu = { day, partial: kind === "partiel" };
      return composeFooter(footer);
    };

    // Note ouverte en édition : via l'éditeur pour ne pas perdre une frappe pas encore enregistrée
    const view = this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find((v) => v instanceof MarkdownView && v.file === file && v.getMode() === "source" && v.editor);
    if (view) {
      const editor = view.editor;
      const old = editor.getValue();
      const next = transform(old);
      let p = 0;
      while (p < old.length && p < next.length && old[p] === next[p]) p++;
      if (next !== old) editor.replaceRange(next.slice(p), editor.offsetToPos(p), editor.offsetToPos(old.length));
    } else {
      await this.app.vault.process(file, transform);
    }
    const labels = { maj: "Mise à jour", lu: "Lue", partiel: "Lue partiellement", "lu-maj": "Lue" };
    new Notice(`${labels[kind]} : ${format(new Date(day))}`);
  }

  // ---------- Marque de lecture d'un passage ----------

  addPassageItems(menu, file, n, line) {
    menu.addItem((item) =>
      item
        .setTitle("Marquer ce passage comme lu")
        .setIcon("eye")
        .setSection("action")
        .onClick(() => this.markPassage(file, n, true))
    );
    if (PASSAGE.test(line || "")) {
      menu.addItem((item) =>
        item
          .setTitle("Retirer la marque de lecture")
          .setIcon("eye-off")
          .setSection("action")
          .onClick(() => this.markPassage(file, n, false))
      );
    }
  }

  // Mode lecture : retrouve la ligne source du bloc cliqué
  onReadingContextMenu(evt) {
    if (evt.defaultPrevented) return;
    const target = evt.target;
    if (!(target instanceof Element) || !target.closest(".markdown-reading-view")) return;
    if (target.closest("a, img, .internal-embed") || window.getSelection()?.toString()) return;
    const view = this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find((v) => v instanceof MarkdownView && v.containerEl.contains(target));
    if (!view || !isTarget(view.file)) return;

    let el = target;
    while (el && !this.sectionContexts.has(el)) el = el.parentElement;
    const info = el && this.sectionContexts.get(el).getSectionInfo(el);
    if (!info) return;
    const li = target.closest("li[data-line]");
    const n = li && el.contains(li) ? info.lineStart + Number(li.getAttribute("data-line")) : info.lineEnd;
    const line = info.text.split(/\r?\n/)[n];

    evt.preventDefault();
    const menu = new Menu();
    this.addPassageItems(menu, view.file, n, line);
    menu.showAtMouseEvent(evt);
  }

  async markPassage(file, n, add) {
    const date = add ? format(new Date()) : null;
    let error = null;
    const transform = (text) => {
      const next = markPassage(text, n, date);
      if (next.startsWith("!")) {
        error = next.slice(1);
        return text;
      }
      return next;
    };
    const view = this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find((v) => v instanceof MarkdownView && v.file === file && v.getMode() === "source" && v.editor);
    if (view) {
      const next = transform(view.editor.getValue());
      if (!error) view.editor.setLine(n, next.split(/\r?\n/)[n]);
    } else {
      await this.app.vault.process(file, transform);
    }
    new Notice(error || (add ? `Passage lu : ${date}` : "Marque de lecture retirée"));
  }

  // ---------- Vue par date ----------

  async index(file, refresh = true) {
    if (!isTarget(file)) return;
    const { maj, lu } = parseFooter(await this.app.vault.cachedRead(file));
    this.footers.set(file.path, { maj, lu });
    if (refresh) this.refreshViews();
  }

  sortedEntries() {
    const dir = this.settings.newestFirst ? -1 : 1;
    const key = this.settings.mode === "lu" ? "lu" : "maj";
    const entries = [];
    for (const [path, footer] of this.footers) {
      const value = footer[key];
      if (!value) continue; // Notes sans date (folder notes de liens…) : non listées
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) entries.push({ file, day: value.day, partial: !!value.partial });
    }
    return entries.sort((a, b) => dir * (a.day - b.day || a.file.stat.mtime - b.file.stat.mtime));
  }

  refreshViews(now = false) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (!(leaf.view instanceof RecentsView)) continue;
      if (now) leaf.view.render();
      else leaf.view.requestRender();
    }
  }

  async revealView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeftLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }
};
