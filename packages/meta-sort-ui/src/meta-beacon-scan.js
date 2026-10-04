/**
 * <meta-beacon-scan> — "what plugins are on the network?", as a card.
 *
 * The Scan button POSTs to the host's own discover endpoint, which probes the
 * beacon v2 group (239.255.99.1:9099), waits for the replies, and classifies
 * every resource matching the host's capability (transport plugins for
 * meta-share, feeders for meta-gateway, enrichment plugins for meta-sort):
 *
 *   10 nodes on the network · 3 transport plugins · 3 already configured
 *
 * Each `addable` row gets an Add button that POSTs {name, url} to the host's
 * existing add endpoint. Response shape: meta-feeder-sdk `beacon::ScanReport`
 * (docs/project-architecture/beacon-v2.md).
 *
 * ⚠ MIRRORED FILE. Byte-identical copies live in meta-share, meta-gateway and
 * meta-sort-ui; see `scripts/check-mirrors.sh`. Edit one → edit all.
 *
 * Shadow DOM for the same reason as <meta-service-menu>: the three hosts use
 * incompatible token vocabularies. Style it from the host with
 *     --mm-scan-fg, --mm-scan-bg, --mm-scan-border, --mm-scan-accent,
 *     --mm-scan-ok, --mm-scan-err
 *
 * Attributes:
 *   scan-endpoint  POST → ScanReport (required)
 *   add-endpoint   POST {name, url, ...add-extra} (required)
 *   add-extra      JSON object merged into the add body (optional)
 *   label          what the host calls a capable resource, plural
 *                  (default "plugins")
 *
 * Events (bubbling, composed):
 *   beacon-added   detail = { candidate, response }, after a successful Add
 */

const STATE_TEXT = {
  addable: "new",
  configured: "configured",
  "bound-elsewhere": "bound elsewhere",
};

const TEMPLATE = `
<style>
  :host {
    --_fg: var(--mm-scan-fg, #e8eaed);
    --_bg: var(--mm-scan-bg, transparent);
    --_border: var(--mm-scan-border, rgba(255, 255, 255, 0.14));
    --_accent: var(--mm-scan-accent, #4ecdc4);
    --_ok: var(--mm-scan-ok, #3fb950);
    --_err: var(--mm-scan-err, #f85149);
    display: block;
    color: var(--_fg);
    font-family: inherit;
    font-size: 14px;
    line-height: 1.4;
  }
  .card {
    background: var(--_bg);
    border: 1px solid var(--_border);
    border-radius: 10px;
    padding: 0.9rem 1rem;
  }
  .head { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .title { font-weight: 600; }
  .hint { opacity: 0.7; font-size: 0.85em; }
  .spacer { flex: 1; }
  button {
    font: inherit;
    font-size: 0.85em;
    cursor: pointer;
    color: var(--_fg);
    background: transparent;
    border: 1px solid var(--_border);
    border-radius: 6px;
    padding: 0.3rem 0.8rem;
  }
  button:hover:not(:disabled) { border-color: var(--_accent); color: var(--_accent); }
  button:disabled { opacity: 0.5; cursor: progress; }
  button.add { border-color: var(--_accent); color: var(--_accent); }
  .summary { margin-top: 0.6rem; font-size: 0.9em; }
  .summary b { color: var(--_accent); }
  .error { margin-top: 0.6rem; color: var(--_err); font-size: 0.85em; }
  ul { list-style: none; margin: 0.6rem 0 0; padding: 0; }
  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.2rem 0.75rem;
    align-items: center;
    padding: 0.5rem 0;
    border-top: 1px solid var(--_border);
  }
  .who { display: flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap; min-width: 0; }
  .name { font-weight: 600; }
  .muted { opacity: 0.65; font-size: 0.85em; }
  code { font-size: 0.8em; opacity: 0.8; overflow-wrap: anywhere; }
  .chips { display: inline-flex; gap: 0.3rem; flex-wrap: wrap; }
  .chip {
    font-size: 0.72em;
    padding: 0 0.4rem;
    border-radius: 3px;
    border: 1px solid var(--_border);
    opacity: 0.85;
  }
  .state { font-size: 0.75em; padding: 0.05rem 0.45rem; border-radius: 999px; border: 1px solid currentColor; }
  .state.addable { color: var(--_accent); }
  .state.configured { color: var(--_ok); }
  .state.bound-elsewhere { opacity: 0.6; }
  .row-actions { display: flex; gap: 0.5rem; align-items: center; grid-row: span 2; }
  .row-err { color: var(--_err); font-size: 0.8em; }
</style>
<div class="card">
  <div class="head">
    <span class="title">Beacon discovery</span>
    <span class="hint">plugins advertising themselves on this network</span>
    <span class="spacer"></span>
    <button class="scan" type="button">Scan</button>
  </div>
  <div class="summary" hidden></div>
  <div class="error" hidden></div>
  <ul></ul>
</div>
`;

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

async function readError(res) {
  const body = await res.text().catch(() => "");
  try {
    const j = JSON.parse(body);
    return j.error || j.message || body || `HTTP ${res.status}`;
  } catch {
    return body || `HTTP ${res.status}`;
  }
}

class MetaBeaconScan extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = TEMPLATE;
    this._scanBtn = this.shadowRoot.querySelector("button.scan");
    this._summary = this.shadowRoot.querySelector(".summary");
    this._error = this.shadowRoot.querySelector(".error");
    this._list = this.shadowRoot.querySelector("ul");
    this._busy = false;
  }

  connectedCallback() {
    if (this._wired) return;
    this._wired = true;
    this._scanBtn.addEventListener("click", () => this.scan());
  }

  get label() {
    return this.getAttribute("label") || "plugins";
  }

  async scan() {
    const endpoint = this.getAttribute("scan-endpoint");
    if (!endpoint || this._busy) return;
    this._busy = true;
    this._scanBtn.disabled = true;
    this._scanBtn.textContent = "Scanning…";
    this._error.hidden = true;
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(await readError(res));
      this._render(await res.json());
    } catch (e) {
      // Keep the last result visible; just say what went wrong.
      this._error.textContent = `Scan failed: ${e.message}`;
      this._error.hidden = false;
    } finally {
      this._busy = false;
      this._scanBtn.disabled = false;
      this._scanBtn.textContent = "Scan again";
    }
  }

  _render(report) {
    const s = report.summary || {};
    this._summary.replaceChildren();
    const part = (n, text) => {
      const span = h("span");
      span.append(h("b", null, String(n ?? 0)), ` ${text}`);
      return span;
    };
    const parts = [
      part(s.nodes, s.nodes === 1 ? "node on the network" : "nodes on the network"),
      part(s.capable, this.label),
      part(s.configured, "already configured"),
      part(s.addable, "new"),
    ];
    if (s.boundElsewhere) parts.push(part(s.boundElsewhere, "bound to another consumer"));
    parts.forEach((p, i) => {
      if (i) this._summary.append(" · ");
      this._summary.append(p);
    });
    this._summary.hidden = false;

    this._list.replaceChildren(...(report.candidates || []).map((c) => this._row(c)));
  }

  _row(c) {
    const li = h("li");
    const who = h("div", "who");
    who.append(h("span", "name", c.instance));
    if (c.name && c.name !== c.instance) who.append(h("span", "muted", c.name));
    if (c.version) who.append(h("span", "muted", `v${c.version}`));
    const chips = h("span", "chips");
    for (const cap of c.caps || []) chips.append(h("span", "chip", cap));
    who.append(chips);

    const actions = h("div", "row-actions");
    const state = h("span", `state ${c.state}`, STATE_TEXT[c.state] || c.state);
    if (c.state === "configured" && c.configuredAs) state.title = `listed as "${c.configuredAs}"`;
    if (c.state === "bound-elsewhere" && c.binds) state.title = `belongs to ${c.binds}`;
    actions.append(state);
    if (c.state === "addable") {
      const add = h("button", "add", "Add");
      add.type = "button";
      add.addEventListener("click", () => this._add(c, add, li));
      actions.append(add);
    }

    const where = h("div");
    where.append(h("code", null, c.url));
    li.append(who, actions, where);
    return li;
  }

  async _add(candidate, btn, li) {
    const endpoint = this.getAttribute("add-endpoint");
    if (!endpoint) return;
    let extra = {};
    try {
      extra = JSON.parse(this.getAttribute("add-extra") || "{}");
    } catch {
      /* a malformed attribute must not block the add */
    }
    btn.disabled = true;
    btn.textContent = "Adding…";
    li.querySelector(".row-err")?.remove();
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ...extra, name: candidate.suggestedName, url: candidate.url }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const text = await res.text();
      let response = null;
      try {
        response = text ? JSON.parse(text) : null;
      } catch {
        response = text;
      }
      this.dispatchEvent(
        new CustomEvent("beacon-added", { bubbles: true, composed: true, detail: { candidate, response } }),
      );
      btn.textContent = "Added";
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Add";
      li.append(h("div", "row-err", e.message));
    }
  }
}

if (!customElements.get("meta-beacon-scan")) {
  customElements.define("meta-beacon-scan", MetaBeaconScan);
}

export default MetaBeaconScan;
