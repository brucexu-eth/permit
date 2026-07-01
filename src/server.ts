import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  allConfig,
  approvalDecision,
  createDraft,
  decidePolicy,
  deriveFundsDirection,
  ensureUser,
  getDraft,
  latestTokenForDemo,
  logEvent,
  migrate,
  openDb,
  seedDefaults,
  setConfig,
  validateToken,
  writeReceipt
} from "./db.js";
import { executeConnector } from "./stripe.js";
import { notifyHermesApproval } from "./hermes.js";
import { handleTelegramCommand, mockTelegramMessage, sendCfoApprovalDm } from "./telegram.js";

const CSS = `
  :root{--bg:#0000f2;--surface:#fff;--surface-alt:#f8f8f8;--ink:#0000d8;--muted:rgba(0,0,216,.82);--line:rgba(0,0,216,.28);--accent:#f2ff4a;--accent-soft:#f8ffa6;--good:#075433;--good-soft:#dfffe8;--warn:#704000;--warn-soft:#fff1b8;--bad:#9b001d;--bad-soft:#ffe1e8;--frame:clamp(10px,1.8vmin,22px);--gutter:clamp(16px,4.8vw,72px);--mono:"Courier Prime","Courier New",ui-monospace,monospace;--display:"Sigurd","Times New Roman",serif}
  *{box-sizing:border-box}
  html{background:var(--bg)}
  body{margin:0;min-height:100vh;background:var(--bg);color:var(--surface-alt);font-family:var(--display);font-synthesis:none;text-transform:uppercase;-webkit-font-smoothing:antialiased}
  body:before{content:"";position:fixed;inset:0;border:var(--frame) solid var(--bg);pointer-events:none;z-index:20;box-shadow:inset 0 0 0 1px rgba(255,255,255,.38)}
  body:after{content:"Permit";position:fixed;right:calc(var(--gutter) * .45);bottom:2vh;color:var(--accent);font-size:min(15vw,170px);line-height:.75;letter-spacing:.03em;opacity:.16;mix-blend-mode:screen;pointer-events:none;z-index:0}
  header{position:sticky;top:0;z-index:10;background:rgba(0,0,242,.94);border-bottom:1px solid rgba(255,255,255,.42);padding:calc(var(--frame) + 10px) var(--gutter) 14px;backdrop-filter:blur(10px)}
  header .header-row{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
  header h1{margin:0;font-size:clamp(30px,4vw,58px);font-weight:300;line-height:.86;letter-spacing:.03em}
  header p{margin:8px 0 0;color:rgba(255,255,255,.96);max-width:620px;font-family:var(--mono);font-size:11px;letter-spacing:.1em;line-height:1.35}
  nav{display:flex;gap:15px;flex-wrap:wrap;align-items:center;font-family:var(--mono);font-size:11px;letter-spacing:.12em}
  nav a{color:var(--surface-alt);text-decoration:none;font-weight:700;text-underline-offset:.35em}
  nav a:hover{text-decoration:underline;color:var(--accent)}
  main{position:relative;z-index:1;max-width:1380px;margin:0 auto;padding:30px var(--gutter) 56px}
  .hero,.panel,.card{background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:4px;box-shadow:0 8px 22px rgba(0,0,0,.16)}
  .hero{position:relative;overflow:hidden;min-height:300px;padding:clamp(24px,4vw,52px);margin-bottom:18px;background:var(--bg);color:#fff;border-color:rgba(255,255,255,.48);box-shadow:none}
  .hero:before{content:"";position:absolute;inset:0;background:radial-gradient(80% 80% at 76% 28%,rgba(237,255,69,.24),transparent 42%),radial-gradient(90% 70% at 50% 40%,transparent 55%,var(--bg) 100%);opacity:.8;pointer-events:none}
  .hero>*{position:relative;z-index:1}
  .hero h2{margin:0 0 18px;max-width:860px;font-size:clamp(42px,5.2vw,74px);font-weight:300;line-height:.9;letter-spacing:.03em}
  .hero p{margin:0;max-width:760px;color:rgba(255,255,255,.96);font-family:var(--mono);font-size:clamp(12px,1vw,15px);letter-spacing:.08em;line-height:1.45}
  .hero-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
  .two-col{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(300px,.9fr);gap:14px;align-items:start}
  .stack{display:grid;gap:14px}
  .panel,.card{padding:16px;margin-bottom:14px}
  .panel h2,.card h3{margin:0 0 12px;font-weight:300;line-height:.98;letter-spacing:.03em}
  .panel h2{font-size:clamp(28px,3.4vw,46px)}
  .card h3{font-size:clamp(20px,2vw,30px)}
  .eyebrow{display:inline-block;margin-bottom:10px;color:var(--ink);font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;opacity:1}
  .hero .eyebrow{color:var(--accent);opacity:1}
  .metric{font-family:var(--display);font-size:clamp(38px,4.8vw,66px);font-weight:300;line-height:.86;letter-spacing:.03em}
  .muted{color:var(--muted)}
  .caption{font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:var(--muted);line-height:1.35}
  .list{display:grid;gap:0}
  .list-item{padding:12px 0;border-top:1px solid var(--line)}
  .list-item:first-child{border-top:0;padding-top:0}
  .split{display:flex;justify-content:space-between;gap:16px;align-items:start;flex-wrap:wrap}
  .amount{font-family:var(--mono);font-weight:700;white-space:nowrap;letter-spacing:.08em}
  .feature-copy{display:grid;gap:12px}
  .feature-copy p{margin:0;color:var(--muted);font-family:var(--mono);font-size:13px;letter-spacing:.04em;line-height:1.45;text-transform:none}
  label{display:block;margin:10px 0 5px;font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.1em}
  input,select,textarea{width:100%;background:var(--surface);color:var(--ink);box-sizing:border-box;padding:9px 10px;border:1px solid var(--line);border-radius:4px;outline:none;font-family:var(--mono);font-size:13px;text-transform:none}
  input:focus,select:focus,textarea:focus{border-color:var(--ink);box-shadow:0 0 0 2px var(--accent)}
  button,.button{display:inline-flex;align-items:center;justify-content:center;background:var(--surface-alt);color:var(--bg);border:1px solid var(--surface-alt);border-radius:0;padding:10px 13px;text-decoration:none;cursor:pointer;margin:3px 3px 3px 0;font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;box-shadow:0 4px 12px rgba(0,0,0,.22)}
  button:hover,.button:hover{background:#fff}
  .button.secondary,button.secondary{background:transparent;color:var(--surface-alt);border:1px solid rgba(245,245,245,.6);box-shadow:none}
  .panel .button.secondary,.card .button.secondary,.panel button.secondary,.card button.secondary{color:var(--ink);border-color:var(--line)}
  .danger{background:var(--bad);border-color:var(--bad);color:#fff}
  .warn{background:var(--accent);border-color:var(--accent);color:var(--bg)}
  .table-wrap{overflow:auto}
  table{width:100%;border-collapse:collapse}
  th{color:var(--muted);font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.1em;text-align:left;padding:0 10px 10px 0}
  td{padding:12px 10px 12px 0;vertical-align:top;border-top:1px solid var(--line);font-family:var(--mono);font-size:12px;letter-spacing:.03em;line-height:1.4;text-transform:none}
  a{color:inherit;text-decoration:underline;text-underline-offset:.28em;text-decoration-thickness:1px}
  code,pre{background:var(--surface-alt);color:var(--ink);border:1px solid var(--line);border-radius:4px;padding:2px 6px;font-family:var(--mono);text-transform:none}
  pre{padding:12px;overflow:auto;line-height:1.4}
  .pill{display:inline-flex;align-items:center;border:1px solid currentColor;border-radius:0;padding:4px 7px;font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}
  .pending{background:var(--warn-soft);color:var(--warn)}
  .approved,.executed,.succeeded{background:var(--good-soft);color:var(--good)}
  .blocked,.rejected,.failed{background:var(--bad-soft);color:var(--bad)}
  .draft,.approval_required{background:var(--accent);color:var(--bg)}
  .mock{background:var(--surface-alt);color:var(--muted)}
  .inflow{background:var(--good-soft);color:var(--good)}
  .outflow{background:var(--bad-soft);color:var(--bad)}
  .kv{display:grid;grid-template-columns:150px 1fr;gap:8px 12px;font-family:var(--mono);font-size:12px;letter-spacing:.03em;text-transform:none}
  .kv div:nth-child(odd){color:var(--muted)}
  strong{font-weight:700;color:var(--ink)}
  summary{cursor:pointer;font-family:var(--mono);letter-spacing:.12em}
  @media (max-width: 860px){body:before{border-width:8px}header{padding:22px 22px 14px}main{padding:22px 22px 44px}.two-col{grid-template-columns:1fr}.hero{min-height:280px}.hero h2{font-size:38px}.kv{grid-template-columns:1fr}nav{gap:10px;font-size:10px}}
`;

const MAX_PORT_RETRIES = 20;

export function startServer(port = Number(process.env.PORT ?? 4733), dbPath?: string) {
  const db = openDb(dbPath);
  migrate(db);
  seedDefaults(db);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname === "/style.css") return send(res, 200, CSS, "text/css");
      if (url.pathname === "/health") return json(res, { ok: true });
      if (url.pathname.startsWith("/api/")) return await api(req, res, url, db);
      return await pages(req, res, url, db);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ((req.url ?? "").startsWith("/api/")) return json(res, { error: message }, 400);
      return send(res, 400, layout("Error", `<div class="panel"><h2>Request failed</h2><p>${escapeHtml(message)}</p><a class="button" href="/">Back</a></div>`));
    }
  });

  const host = process.env.HOST ?? "0.0.0.0";
  let selectedPort = port;
  let retryCount = 0;

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && retryCount < MAX_PORT_RETRIES) {
      const occupiedPort = selectedPort;
      selectedPort += 1;
      retryCount += 1;
      console.warn(`Port ${occupiedPort} is already in use; trying ${selectedPort}.`);
      server.listen(selectedPort, host);
      return;
    }

    throw error;
  });

  server.listen(selectedPort, host, () => {
    console.log(`Permit web app listening at http://${host === "0.0.0.0" ? "localhost" : host}:${selectedPort}`);
  });
  return server;
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL, db: ReturnType<typeof openDb>) {
  const method = req.method ?? "GET";
  const approvalMatch = url.pathname.match(/^\/api\/approvals\/(\d+)\/(approve|reject)$/);
  const actionMatch = url.pathname.match(/^\/api\/actions\/(\d+)\/(check|execute)$/);
  const auditMatch = url.pathname.match(/^\/api\/audit\/(\d+)$/);

  if (method === "POST" && url.pathname === "/api/actions/draft") {
    const body = await readBody(req);
    const draft = createDraft(db, body);
    const decision = decidePolicy(db, Number(draft?.id));
    const approval = db.prepare("SELECT * FROM approval_requests WHERE action_id = ? ORDER BY id DESC LIMIT 1").get(Number(draft?.id));
    const approvalNotification = approval && draft ? await sendCfoApprovalDm(db, Number((approval as Record<string, unknown>).id), draft) : null;
    return json(res, { draft, decision, approval, approval_notification: approvalNotification });
  }
  if (method === "POST" && actionMatch?.[2] === "check") {
    return json(res, decidePolicy(db, Number(actionMatch[1])));
  }
  if (method === "POST" && approvalMatch) {
    const body = await readBody(req);
    const status = approvalMatch[2] === "approve" ? "approved" : "rejected";
    const result = approvalDecision(db, Number(approvalMatch[1]), status, body.telegram_user_id ?? null, body.note ?? "");
    const actionId = Number((result.approval as Record<string, unknown>).action_id);
    const hermes = await notifyHermesApproval(db, actionId, Number(approvalMatch[1]), status, result.token);
    return json(res, { ...result, hermes });
  }
  if (method === "POST" && actionMatch?.[2] === "execute") {
    const body = await readBody(req);
    const actionId = Number(actionMatch[1]);
    const action = getDraft(db, actionId);
    if (!action) throw new Error("Action not found");
    if (!body.approval_token || !validateToken(db, actionId, String(body.approval_token))) {
      logEvent(db, "execution.denied", "api", actionId, { reason: "missing_or_invalid_approval_token" });
      throw new Error("Execution requires a valid one-time Permit approval token.");
    }
    const started = db.prepare("INSERT INTO executions (action_id, connector, status) VALUES (?, 'mock', 'started')").run(actionId);
    const execId = Number(started.lastInsertRowid);
    const connector = await executeConnector(db, action);
    db.prepare("UPDATE executions SET connector = ?, status = ?, external_id = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
      connector.connector,
      connector.status,
      connector.external_id,
      connector.error,
      execId
    );
    db.prepare("UPDATE action_drafts SET status = ? WHERE id = ?").run(connector.status === "succeeded" ? "executed" : "failed", actionId);
    const receiptId = writeReceipt(db, actionId, execId);
    return json(res, { execution_id: execId, receipt_id: receiptId, connector, summary: executionSummary(action, connector, receiptId) });
  }
  if (method === "POST" && url.pathname === "/api/telegram/mock") {
    const body = await readBody(req);
    return json(res, handleTelegramCommand(db, String(body.telegram_user_id), String(body.command)));
  }
  if (method === "GET" && url.pathname === "/api/approvals") {
    return json(res, db.prepare("SELECT ar.*, ad.vendor, ad.amount, ad.currency, ad.reason FROM approval_requests ar JOIN action_drafts ad ON ad.id = ar.action_id ORDER BY ar.created_at DESC").all());
  }
  if (method === "GET" && url.pathname === "/api/audit") {
    return json(res, db.prepare("SELECT * FROM audit_receipts ORDER BY id DESC").all());
  }
  if (method === "GET" && auditMatch) {
    return json(res, db.prepare("SELECT * FROM audit_receipts WHERE id = ?").get(Number(auditMatch[1])) ?? {});
  }
  return json(res, { error: "Not found" }, 404);
}

async function pages(req: IncomingMessage, res: ServerResponse, url: URL, db: ReturnType<typeof openDb>) {
  if (req.method === "POST" && url.pathname === "/setup") {
    const body = await readBody(req);
    setConfig(db, "company_name", String(body.company_name ?? ""));
    setConfig(db, "admin_name", String(body.admin_name ?? ""));
    setConfig(db, "cfo_telegram_user_id", String(body.cfo_telegram_user_id ?? ""));
    setConfig(db, "hermes_webhook_url", String(body.hermes_webhook_url ?? ""));
    setConfig(db, "default_currency", String(body.default_currency ?? "USD").toUpperCase());
    if (body.stripe_secret_key) setConfig(db, "stripe_secret_key", String(body.stripe_secret_key));
    if (body.hermes_webhook_secret) setConfig(db, "hermes_webhook_secret", String(body.hermes_webhook_secret));
    ensureUser(db, String(body.admin_name ?? "Admin"), "admin");
    ensureUser(db, "CFO", "cfo", String(body.cfo_telegram_user_id ?? ""));
    return redirect(res, "/");
  }
  if (req.method === "POST" && url.pathname === "/demo-draft") {
    const body = await readBody(req);
    const draft = createDraft(db, { ...body, recurring: body.recurring === "on", raw_request: body.raw_request || JSON.stringify(body) });
    decidePolicy(db, Number(draft?.id));
    const approval = db.prepare("SELECT * FROM approval_requests WHERE action_id = ? ORDER BY id DESC LIMIT 1").get(Number(draft?.id)) as Record<string, unknown> | undefined;
    if (approval && draft) await sendCfoApprovalDm(db, Number(approval.id), draft);
    return redirect(res, "/approvals");
  }
  const approvalAction = url.pathname.match(/^\/approvals\/(\d+)\/(approve|reject)$/);
  if (req.method === "POST" && approvalAction) {
    const body = await readBody(req);
    const status = approvalAction[2] === "approve" ? "approved" : "rejected";
    const cfg = allConfig(db);
    const result = approvalDecision(db, Number(approvalAction[1]), status, cfg.cfo_telegram_user_id ?? null, body.note ? String(body.note) : "");
    const actionId = Number((result.approval as Record<string, unknown>).action_id);
    await notifyHermesApproval(db, actionId, Number(approvalAction[1]), status, result.token);
    const tokenQuery = result.token ? `?token=${encodeURIComponent(result.token)}` : "";
    return redirect(res, status === "rejected" ? "/approvals" : `/actions/${actionId}${tokenQuery}`);
  }
  const approvalLinkAction = url.pathname.match(/^\/approvals\/(\d+)\/(approve|reject)-link$/);
  if (req.method === "GET" && approvalLinkAction) {
    const status = approvalLinkAction[2] === "approve" ? "approved" : "rejected";
    const cfg = allConfig(db);
    const result = approvalDecision(db, Number(approvalLinkAction[1]), status, cfg.cfo_telegram_user_id ?? null, "Decided from Telegram DM button");
    const actionId = Number((result.approval as Record<string, unknown>).action_id);
    await notifyHermesApproval(db, actionId, Number(approvalLinkAction[1]), status, result.token);
    const tokenQuery = result.token ? `?token=${encodeURIComponent(result.token)}` : "";
    return redirect(res, status === "rejected" ? "/approvals" : `/actions/${actionId}${tokenQuery}`);
  }
  if (req.method === "POST" && url.pathname.match(/^\/actions\/\d+\/execute$/)) {
    const actionId = Number(url.pathname.split("/")[2]);
    const body = await readBody(req);
    const action = getDraft(db, actionId);
    if (!action) throw new Error("Action not found");
    if (!body.approval_token || !validateToken(db, actionId, String(body.approval_token))) throw new Error("Execution requires a valid one-time Permit approval token.");
    const started = db.prepare("INSERT INTO executions (action_id, connector, status) VALUES (?, 'mock', 'started')").run(actionId);
    const execId = Number(started.lastInsertRowid);
    const connector = await executeConnector(db, action);
    db.prepare("UPDATE executions SET connector = ?, status = ?, external_id = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(connector.connector, connector.status, connector.external_id, connector.error, execId);
    db.prepare("UPDATE action_drafts SET status = ? WHERE id = ?").run(connector.status === "succeeded" ? "executed" : "failed", actionId);
    const receiptId = writeReceipt(db, actionId, execId);
    return redirect(res, `/receipts/${receiptId}`);
  }

  if (url.pathname === "/") return send(res, 200, layout("Dashboard", dashboardPage(db)));
  if (url.pathname === "/setup") return send(res, 200, layout("Setup", setupPage(db)));
  if (url.pathname === "/approvals") return send(res, 200, layout("Approval Inbox", approvalsPage(db)));
  if (url.pathname === "/audit") return send(res, 200, layout("Audit Ledger", auditPage(db)));
  if (url.pathname === "/policies") return send(res, 200, layout("Policies", policiesPage(db)));
  const receiptMatch = url.pathname.match(/^\/receipts\/(\d+)$/);
  if (receiptMatch) return send(res, 200, layout("Receipt Detail", receiptPage(db, Number(receiptMatch[1]))));
  const actionMatch = url.pathname.match(/^\/actions\/(\d+)$/);
  if (actionMatch) return send(res, 200, layout("Action Detail", actionPage(db, Number(actionMatch[1]), url.searchParams.get("token"))));
  return send(res, 404, layout("Not Found", `<div class="panel"><h2>Not found</h2></div>`));
}

function dashboardPage(db: ReturnType<typeof openDb>) {
  const cfg = allConfig(db);
  const hasStripeSecretKey = Boolean(cfg.stripe_secret_key);
  const counts = {
    pending: (db.prepare("SELECT COUNT(*) count FROM approval_requests WHERE status = 'pending'").get() as { count: number }).count,
    actions: (db.prepare("SELECT COUNT(*) count FROM action_drafts").get() as { count: number }).count,
    receipts: (db.prepare("SELECT COUNT(*) count FROM audit_receipts").get() as { count: number }).count,
    executed: (db.prepare("SELECT COUNT(*) count FROM action_drafts WHERE status = 'executed'").get() as { count: number }).count
  };
  const pendingRows = db.prepare(`
    SELECT ar.id approval_id, ar.action_id, ar.status approval_status, ad.vendor, ad.amount, ad.currency, ad.requester, ad.reason, ad.created_at
    FROM approval_requests ar
    JOIN action_drafts ad ON ad.id = ar.action_id
    WHERE ar.status = 'pending'
    ORDER BY ar.created_at DESC
    LIMIT 6
  `).all() as Record<string, unknown>[];
  const recentActions = db.prepare(`
    SELECT id, vendor, amount, currency, requester, status, reason, created_at
    FROM action_drafts
    ORDER BY created_at DESC, id DESC
    LIMIT 8
  `).all() as Record<string, unknown>[];
  const mockAuditSeries = [
    { label: "Approved outflow", amount: 1240, tone: "bad" },
    { label: "Refund inflow", amount: 410, tone: "good" },
    { label: "Protected by approval gate", amount: 3250, tone: "mock" }
  ];
  const inflow = mockAuditSeries.filter((item) => item.tone === "good").reduce((sum, item) => sum + item.amount, 0);
  const outflow = mockAuditSeries.filter((item) => item.tone === "bad").reduce((sum, item) => sum + item.amount, 0);
  const guarded = mockAuditSeries.filter((item) => item.tone === "mock").reduce((sum, item) => sum + item.amount, 0);
  const company = cfg.company_name ?? "Permit demo workspace";

  return `
    <section class="hero">
      <span class="eyebrow">Operations dashboard</span>
      <h2>${escapeHtml(company)} finance control room</h2>
      <p>Permit keeps Hermes useful without giving it unchecked spend authority. The homepage focuses on live approvals, recent orders, and a lightweight auditing snapshot instead of setup tasks.</p>
      <div class="hero-actions">
        <a class="button" href="/approvals">Review approvals</a>
        <a class="button secondary" href="/setup">Open setup</a>
      </div>
    </section>
    <div class="grid">
      <div class="card"><div class="metric">${counts.pending}</div><div>Pending approvals</div><div class="caption">Orders currently waiting for CFO or finance sign-off.</div></div>
      <div class="card"><div class="metric">${counts.actions}</div><div>Action drafts</div><div class="caption">Hermes and local simulations that entered Permit.</div></div>
      <div class="card"><div class="metric">${counts.executed}</div><div>Executed actions</div><div class="caption">Requests that cleared policy and completed execution.</div></div>
      <div class="card"><div class="metric">${counts.receipts}</div><div>Audit receipts</div><div class="caption">Tamper-evident records written to the local ledger.</div></div>
    </div>
    <div class="two-col">
      <section class="panel">
        <div class="split">
          <div>
            <span class="eyebrow">Pending queue</span>
            <h2>Orders waiting for approval</h2>
          </div>
          <a class="button secondary" href="/approvals">Open inbox</a>
        </div>
        ${pendingRows.length ? `<div class="list">${pendingRows.map((row) => `
          <article class="list-item">
            <div class="split">
              <div>
                <div><a href="/actions/${row.action_id}">${escapeHtml(String(row.vendor))}</a> · ${escapeHtml(String(row.requester))}</div>
                <div class="muted">${escapeHtml(String(row.reason))}</div>
              </div>
              <div style="text-align:right">
                <div class="amount">${escapeHtml(String(row.amount))} ${escapeHtml(String(row.currency))}</div>
                <div>${statusPill(String(row.approval_status))}</div>
              </div>
            </div>
          </article>
        `).join("")}</div>` : `<p class="muted">No orders are waiting for approval right now.</p>`}
      </section>
      <div class="stack">
        <section class="panel">
          <span class="eyebrow">Hackathon stack</span>
          <h2>Why these pieces matter</h2>
          <div class="feature-copy">
            <p><strong>Stripe Skills for Hermes</strong> gives the demo a realistic execution path. Hermes can understand payment and procurement intent, while Permit keeps the Stripe credential outside the agent and forces approval before any test-mode money movement.</p>
            <p><strong>NemoClaw Nemotron 3 Ultra</strong> strengthens the assistant side of the hackathon story. It helps Hermes interpret messy user requests, draft better procurement context, and route richer action details into Permit for policy review and auditing.</p>
          </div>
        </section>
        <section class="panel">
          <div class="split">
            <div>
              <span class="eyebrow">Auditing</span>
              <h2>Mock cashflow snapshot</h2>
            </div>
            <span class="pill mock">Mock data</span>
          </div>
          <div class="grid">
            <div class="card"><div class="metric">${formatCurrency(inflow)}</div><div>Funds in</div></div>
            <div class="card"><div class="metric">${formatCurrency(outflow)}</div><div>Funds out</div></div>
            <div class="card"><div class="metric">${formatCurrency(guarded)}</div><div>Guarded volume</div></div>
          </div>
          <div class="list">
            ${mockAuditSeries.map((item) => `
              <div class="list-item">
                <div class="split">
                  <span>${escapeHtml(item.label)}</span>
                  <span class="pill ${item.tone}">${formatCurrency(item.amount)}</span>
                </div>
              </div>
            `).join("")}
          </div>
        </section>
      </div>
    </div>
    <section class="panel">
      <div class="split">
        <div>
          <span class="eyebrow">Activity list</span>
          <h2>Recent agent orders</h2>
        </div>
        <a class="button secondary" href="/audit">View audit ledger</a>
      </div>
      ${recentActions.length ? table(["Action", "Requester", "Amount", "Status", "Created"], recentActions.map((row) => [
        `<a href="/actions/${row.id}">${escapeHtml(String(row.vendor))}</a><br><span class="muted">${escapeHtml(String(row.reason))}</span>`,
        escapeHtml(String(row.requester)),
        `${escapeHtml(String(row.amount))} ${escapeHtml(String(row.currency))}`,
        statusPill(String(row.status)),
        escapeHtml(String(row.created_at))
      ])) : "<p class=\"muted\">No agent orders yet. Use setup to seed a demo draft.</p>"}
    </section>`;
}

function setupPage(db: ReturnType<typeof openDb>) {
  const cfg = allConfig(db);
  const hasStripeSecretKey = Boolean(cfg.stripe_secret_key);
  return `
    <section class="hero">
      <span class="eyebrow">Workspace setup</span>
      <h2>Configure Permit for the demo flow</h2>
      <p>Setup is intentionally separate from the homepage. Use this page to wire company defaults, the CFO Telegram identity, and the Stripe test connector before creating simulated Hermes requests.</p>
    </section>
    <div class="two-col">
      <div class="stack">
        <div class="panel">
          <h2>Setup</h2>
          <form method="post" action="/setup">
            <label>Company name</label><input name="company_name" value="${escapeAttr(cfg.company_name ?? "Acme AI Ops")}">
            <label>Admin name</label><input name="admin_name" value="${escapeAttr(cfg.admin_name ?? "Bruce")}">
            <label>CFO Telegram ID</label><input name="cfo_telegram_user_id" value="${escapeAttr(cfg.cfo_telegram_user_id ?? "")}" required>
            <label>Hermes webhook URL</label><input name="hermes_webhook_url" placeholder="http://localhost:8644/webhooks/permit-approved" value="${escapeAttr(cfg.hermes_webhook_url ?? "")}">
            <label>Hermes webhook secret</label><input type="password" name="hermes_webhook_secret" placeholder="${cfg.hermes_webhook_secret ? "Saved secret hidden. Enter a new secret to replace it." : "HMAC secret from hermes webhook subscribe"}" autocomplete="new-password">
            <label>Stripe test secret key</label><input type="password" name="stripe_secret_key" placeholder="${hasStripeSecretKey ? "Saved key hidden. Enter a new sk_test_... to replace it." : "sk_test_... or leave blank for mock"}" autocomplete="new-password">
            <p class="muted">${hasStripeSecretKey ? "A Stripe test key is already saved and hidden in this form." : "Leave blank to keep using the mock connector."}</p>
            <label>Default currency</label><input name="default_currency" value="${escapeAttr(cfg.default_currency ?? "USD")}">
            <button>Save setup</button>
          </form>
        </div>
        <div class="panel">
          <h2>Create Hermes draft</h2>
          <form method="post" action="/demo-draft">
            <label>Requester</label><input name="requester" value="${escapeAttr(cfg.admin_name ?? "Bruce")}">
            <label>Vendor</label><input name="vendor" value="Figma">
            <label>Amount</label><input name="amount" type="number" step="0.01" value="75">
            <label>Currency</label><input name="currency" value="${escapeAttr(cfg.default_currency ?? "USD")}">
            <label>Action type</label><input name="action_type" value="saas_purchase">
            <label>Reason</label><input name="reason" value="Buy 5 Figma seats for the design team">
            <label><input name="recurring" type="checkbox" checked style="width:auto"> Recurring subscription</label>
            <input name="source_agent" type="hidden" value="hermes">
            <button>Create action draft</button>
          </form>
        </div>
      </div>
      <div class="stack">
        <div class="panel">
          <span class="eyebrow">Hackathon context</span>
          <h2>How Hermes stays useful and safe</h2>
          <div class="feature-copy">
            <p><strong>Stripe Skills for Hermes</strong> provides the payment and commerce-aware behavior users expect in the demo. Permit wraps that capability with approval policy, token-gated execution, and Stripe test-mode isolation so Hermes never carries the secret key itself.</p>
            <p><strong>NemoClaw Nemotron 3 Ultra</strong> improves the quality of intent understanding and action drafting. In practice that means clearer vendor, amount, and rationale fields before a request lands in the approval inbox, which makes both policy decisions and audits easier to trust.</p>
          </div>
        </div>
        <div class="panel">
          <h2>What to do next</h2>
          <div class="list">
            <div class="list-item"><strong>1.</strong> Save setup with the CFO Telegram ID and optional Stripe test key.</div>
            <div class="list-item"><strong>2.</strong> Create a Hermes draft to simulate a procurement or payment request.</div>
            <div class="list-item"><strong>3.</strong> Go back to the dashboard to monitor pending approvals and mock auditing metrics.</div>
          </div>
        </div>
      </div>
    </div>`;
}

function approvalsPage(db: ReturnType<typeof openDb>) {
  const rows = db.prepare("SELECT ar.*, ad.vendor, ad.amount, ad.currency, ad.requester, ad.reason, ad.status action_status FROM approval_requests ar JOIN action_drafts ad ON ad.id = ar.action_id ORDER BY ar.created_at DESC").all() as Record<string, unknown>[];
  return `<div class="panel"><h2>Approval Inbox</h2>${rows.length ? table(["ID", "Action", "Requester", "Amount", "Status", "Actions"], rows.map((row) => [
    row.id,
    `<a href="/actions/${row.action_id}">${escapeHtml(String(row.vendor))}</a><br><span class="muted">${escapeHtml(String(row.reason))}</span>`,
    row.requester,
    `${row.amount} ${row.currency}`,
    statusPill(String(row.status)),
    row.status === "pending" ? decisionForms(row) : ""
  ])) : "<p>No approvals yet.</p>"}</div>`;
}

function decisionForms(row: Record<string, unknown>) {
  return `
    <form method="post" action="/approvals/${row.id}/approve"><button>Approve</button></form>
    <form method="post" action="/approvals/${row.id}/reject"><button class="danger">Reject</button></form>`;
}

function auditPage(db: ReturnType<typeof openDb>) {
  const rows = db.prepare("SELECT ar.*, ad.vendor, ad.amount, ad.currency, ad.action_type, ad.reason FROM audit_receipts ar JOIN action_drafts ad ON ad.id = ar.action_id ORDER BY ar.id DESC").all() as Record<string, unknown>[];
  return `<div class="panel"><h2>Audit Ledger</h2>${rows.length ? table(["Receipt", "Flow", "Action", "Execution", "Hash", "Previous"], rows.map((row) => {
    const payload = parseReceiptPayload(row.receipt_json);
    const summary = getAuditSummary(payload, row);
    const connector = summary.connector || "unknown";
    const externalId = summary.external_id || "n/a";
    return [
    `<a href="/receipts/${row.id}">#${row.id}</a>`,
    `${statusPill(summary.direction)}<br><span class="muted">${escapeHtml(readableDirection(summary.direction))}</span>`,
    `<strong>${escapeHtml(String(row.vendor))}</strong><br><span class="muted">#${escapeHtml(String(summary.action_id))} · ${escapeHtml(String(row.action_type ?? "payment"))} · ${escapeHtml(String(row.amount))} ${escapeHtml(String(row.currency))}</span>`,
    `<span class="pill ${escapeHtml(connector)}">${escapeHtml(connector)}</span><br><span class="muted">${escapeHtml(externalId)}</span>`,
    `<code>${escapeHtml(String(row.receipt_hash)).slice(0, 18)}...</code>`,
    row.previous_hash ? `<code>${escapeHtml(String(row.previous_hash)).slice(0, 18)}...</code>` : "genesis"
  ];
  })) : "<p>No receipts yet.</p>"}</div>`;
}

function policiesPage(db: ReturnType<typeof openDb>) {
  const rows = db.prepare("SELECT * FROM policies ORDER BY version DESC").all() as Record<string, unknown>[];
  return `<div class="panel"><h2>Policies</h2>${rows.length ? table(["Version", "Status", "Rule", "Effect"], rows.flatMap((row) => {
    const rules = parsePolicyRulesForPage(row.rules_json);
    return [
      [row.version, statusPill(String(row.status)), "Stripe test execution", rules.requireApprovalForStripe ? "Requires CFO approval" : "Allowed by policy unless another rule catches it"],
      [row.version, statusPill(String(row.status)), "Recurring purchases", rules.requireApprovalForRecurring ? "Requires CFO approval" : "Allowed by policy unless another rule catches it"],
      [row.version, statusPill(String(row.status)), "Mock actions", `Auto-allow under ${escapeHtml(String(rules.autoAllowMockUnderUsd))} USD; require approval at or above that amount`],
      [row.version, statusPill(String(row.status)), "Unknown vendor", `Block above ${escapeHtml(String(rules.blockUnknownVendorAboveUsd))} USD`],
      [row.version, statusPill(String(row.status)), "Missing CFO Telegram ID", rules.blockWithoutCfoTelegramId ? "Block action" : "Do not block only for missing CFO ID"]
    ];
  })) : "<p>No policies configured.</p>"}<details><summary>Raw policy JSON</summary><pre>${escapeHtml(JSON.stringify(rows, null, 2))}</pre></details></div>`;
}

function receiptPage(db: ReturnType<typeof openDb>, id: number) {
  const row = db.prepare("SELECT * FROM audit_receipts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return `<div class="panel"><h2>Receipt not found</h2></div>`;
  const payload = parseReceiptPayload(row.receipt_json);
  const action = payload.action ?? {};
  const decision = payload.policy_decision ?? {};
  const approval = payload.approval ?? {};
  const execution = payload.execution ?? {};
  const summary = getAuditSummary(payload, row);
  return `
    <section class="hero">
      <h2>Audit Receipt #${id}</h2>
      <p>${escapeHtml(String(action.vendor ?? "Unknown vendor"))} · ${escapeHtml(String(action.amount ?? ""))} ${escapeHtml(String(action.currency ?? ""))} · ${statusPill(String(execution.status ?? action.status ?? "unknown"))} · ${statusPill(summary.direction)}</p>
      <p class="muted">Hash <code>${escapeHtml(String(row.receipt_hash))}</code></p>
    </section>
    <div class="grid">
      <div class="card"><h3>Action</h3>${kv({ Type: action.action_type, Direction: readableDirection(summary.direction), Vendor: action.vendor, Amount: `${action.amount} ${action.currency}`, Requester: action.requester, Agent: action.source_agent, Risk: action.risk_level, Reason: action.reason })}</div>
      <div class="card"><h3>Policy</h3>${kv({ Result: statusPill(String(decision.result ?? "unknown")), Version: payload.policy_version, Reasons: parseReasons(decision.reasons_json).join("; ") })}</div>
      <div class="card"><h3>Approval</h3>${kv({ Status: statusPill(String(approval.status ?? "none")), Approver: approval.approver_user_id ? `User #${approval.approver_user_id}` : "none", Note: approval.decision_note ?? "", Decided: approval.decided_at ?? "" })}</div>
      <div class="card"><h3>Execution</h3>${kv({ Connector: summary.connector || execution.connector, Status: statusPill(String(execution.status ?? "not_started")), ExternalID: summary.external_id || execution.external_id || "n/a", ActionID: summary.action_id, ReceiptID: id, Error: execution.error ?? "" })}</div>
    </div>
    <div class="panel"><h2>Tamper evidence</h2>${kv({ PreviousHash: row.previous_hash ?? "genesis", ReceiptHash: row.receipt_hash })}</div>
    <details class="panel"><summary>Raw receipt JSON</summary><pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre></details>`;
}

function actionPage(db: ReturnType<typeof openDb>, id: number, approvalToken: string | null) {
  const action = getDraft(db, id);
  if (!action) return `<div class="panel"><h2>Action not found</h2></div>`;
  const approval = db.prepare("SELECT * FROM approval_requests WHERE action_id = ? ORDER BY id DESC LIMIT 1").get(id) as Record<string, unknown> | undefined;
  const token = latestTokenForDemo(db, id);
  const telegram = approval ? mockTelegramMessage(db, Number(approval.id), action) : "";
  return `<section class="hero"><h2>Action #${id}: ${escapeHtml(String(action.vendor ?? "Unknown"))}</h2><p>${escapeHtml(String(action.reason ?? ""))}</p></section>
    <div class="grid">
      <div class="card"><h3>Draft</h3>${kv({ Type: action.action_type, Vendor: action.vendor, Amount: `${action.amount} ${action.currency}`, Requester: action.requester, Agent: action.source_agent, Risk: action.risk_level, Status: statusPill(String(action.status)) })}</div>
      <div class="card"><h3>Approval</h3>${approval ? kv({ ApprovalID: approval.id, Status: statusPill(String(approval.status)), Decided: approval.decided_at ?? "pending" }) : "<p class=\"muted\">No approval request.</p>"}</div>
    </div>
    ${telegram ? `<div class="panel"><h2>Mock Telegram DM</h2><pre>${escapeHtml(telegram)}</pre></div>` : ""}
    <div class="panel"><h2>Execution Guard</h2><p>Sensitive execution requires a one-time Permit approval token.</p><p class="muted">Demo token record: ${token ? escapeHtml(JSON.stringify(token)) : "none issued yet"}</p>
    <form method="post" action="/actions/${id}/execute"><label>Approval token</label><input name="approval_token" value="${escapeAttr(approvalToken ?? "")}" placeholder="Returned after CFO approval"><button>Execute</button></form></div>`;
}

function layout(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Permit - ${title}</title><link rel="stylesheet" href="/style.css"></head>
  <body><header><div class="header-row"><div><h1>Permit</h1><p>Approval and audit for enterprise AI agent financial actions.</p></div><nav><a href="/">Dashboard</a><a href="/setup">Setup</a><a href="/approvals">Approvals</a><a href="/audit">Audit Ledger</a><a href="/policies">Policies</a></nav></div></header><main>${body}</main></body></html>`;
}

function table(headers: string[], rows: unknown[][]) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

async function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return {};
  const contentType = req.headers["content-type"] ?? "";
  if (String(contentType).includes("application/json")) return JSON.parse(raw);
  return Object.fromEntries(new URLSearchParams(raw));
}

function json(res: ServerResponse, value: unknown, status = 200) {
  return send(res, status, JSON.stringify(value, null, 2), "application/json");
}

function send(res: ServerResponse, status: number, body: string, contentType = "text/html") {
  res.writeHead(status, { "content-type": `${contentType}; charset=utf-8` });
  res.end(body);
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(303, { location });
  res.end();
}

function statusPill(status: string) {
  const safe = escapeHtml(status);
  const cls = safe.toLowerCase().replace(/[^a-z0-9_ -]/g, "").replace(/\s+/g, "_");
  return `<span class="pill ${cls}">${safe}</span>`;
}

function kv(values: Record<string, unknown>) {
  return `<div class="kv">${Object.entries(values).map(([key, value]) => `<div>${escapeHtml(key)}</div><div>${typeof value === "string" && value.startsWith("<span") ? value : escapeHtml(String(value ?? ""))}</div>`).join("")}</div>`;
}

function parseReasons(value: unknown) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return [String(value)];
  }
}

function parseReceiptPayload(value: unknown) {
  try {
    return JSON.parse(String(value ?? "{}")) as Record<string, any>;
  } catch {
    return {};
  }
}

function parsePolicyRulesForPage(value: unknown) {
  const defaults = {
    autoAllowMockUnderUsd: 10,
    requireApprovalForStripe: true,
    requireApprovalForRecurring: true,
    blockUnknownVendorAboveUsd: 500,
    blockWithoutCfoTelegramId: true
  };
  try {
    const parsed = JSON.parse(String(value ?? "{}")) as Partial<typeof defaults>;
    return {
      autoAllowMockUnderUsd: Number(parsed.autoAllowMockUnderUsd ?? defaults.autoAllowMockUnderUsd),
      requireApprovalForStripe: Boolean(parsed.requireApprovalForStripe ?? defaults.requireApprovalForStripe),
      requireApprovalForRecurring: Boolean(parsed.requireApprovalForRecurring ?? defaults.requireApprovalForRecurring),
      blockUnknownVendorAboveUsd: Number(parsed.blockUnknownVendorAboveUsd ?? defaults.blockUnknownVendorAboveUsd),
      blockWithoutCfoTelegramId: Boolean(parsed.blockWithoutCfoTelegramId ?? defaults.blockWithoutCfoTelegramId)
    };
  } catch {
    return defaults;
  }
}

function getAuditSummary(payload: Record<string, any>, row: Record<string, unknown>) {
  const action = payload.action && typeof payload.action === "object" ? payload.action as Record<string, unknown> : undefined;
  const execution = payload.execution && typeof payload.execution === "object" ? payload.execution as Record<string, unknown> : undefined;
  const summary = payload.audit_summary && typeof payload.audit_summary === "object" ? payload.audit_summary as Record<string, unknown> : {};
  const direction = String(summary.direction ?? deriveFundsDirection(action));
  return {
    direction,
    connector: String(summary.connector ?? execution?.connector ?? ""),
    external_id: String(summary.external_id ?? execution?.external_id ?? ""),
    action_id: Number(summary.action_id ?? payload.action?.id ?? row.action_id ?? 0)
  };
}

function readableDirection(direction: string) {
  return direction === "inflow" ? "Funds in" : "Funds out";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]!));
}

function escapeAttr(value: string) {
  return escapeHtml(value);
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
}

function executionSummary(action: Record<string, unknown>, connector: Record<string, unknown>, receiptId: number) {
  return {
    action_id: Number(action.id),
    vendor: action.vendor,
    action_type: action.action_type,
    amount: action.amount,
    currency: action.currency,
    recurring: Boolean(action.recurring),
    requester: action.requester,
    reason: action.reason,
    status: connector.status,
    connector: connector.connector,
    stripe_or_external_id: connector.external_id,
    receipt_id: receiptId,
    error: connector.error ?? null
  };
}
