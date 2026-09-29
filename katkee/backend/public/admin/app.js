/**
 * Katkee Admin Console — a hand-rolled, zero-build vanilla JS single-page
 * app served directly by the existing hand-rolled HTTP server (see
 * ../../src/modules/admin/console.routes.ts). It carries no authority of
 * its own: every view is a thin fetch()-driven client of the same JSON API
 * every other Katkee client (including the mobile app) talks to, and every
 * one of those endpoints independently re-verifies auth + role + permission
 * server-side (see permissions.service.ts's requirePermission) — hiding a
 * button here is a UX nicety only, never real access control.
 *
 * The access token lives in sessionStorage (this browser tab only, cleared
 * on tab close) — never a cookie, so there's no CSRF surface to reason
 * about; the same Bearer-token model the mobile app already uses against
 * this exact backend.
 */
(function () {
  "use strict";

  const TOKEN_KEY = "katkee_admin_token";
  const app = document.getElementById("app");

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  }
  function setToken(token) {
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
  }
  function clearToken() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  }

  async function api(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    const token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      clearToken();
      location.hash = "#/login";
      throw new Error("Session expired. Please log in again.");
    }
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const message = (data && (data.message || (data.fields && JSON.stringify(data.fields)))) || res.statusText;
      throw new Error(message);
    }
    return data;
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "onclick") node.addEventListener("click", v);
      else if (k === "onsubmit") node.addEventListener("submit", v);
      else if (k === "html") node.innerHTML = v;
      else node.setAttribute(k, v);
    }
    for (const child of children || []) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function showToast(message, isError) {
    const toast = el("div", { class: "toast" + (isError ? " error" : "") }, [message]);
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  function badge(text) {
    return el("span", { class: "badge " + text }, [text]);
  }

  // --- Shell / routing ------------------------------------------------------

  const ROUTES = [
    { path: "staff", label: "Admins & Permissions" },
    { path: "moderation", label: "Moderation Queue" },
    { path: "moderation-history", label: "Moderation History" },
    { path: "ads", label: "Advertising" },
    { path: "flags", label: "Feature Flags" },
    { path: "audit", label: "Audit Log" },
  ];

  let currentUser = null;

  function renderShell(activePath, contentNode) {
    const sidebar = el("div", { class: "sidebar" }, [
      el("div", { class: "brand" }, ["Katkee Admin"]),
      el(
        "div",
        { class: "who" },
        [
          currentUser ? currentUser.username + (currentUser.isPrimaryAdmin ? " (SUPER_ADMIN)" : " (ADMIN)") : "",
        ],
      ),
      el(
        "nav",
        {},
        ROUTES.map((r) =>
          el("a", { class: r.path === activePath ? "active" : "", onclick: () => (location.hash = "#/" + r.path) }, [r.label]),
        ).concat([el("a", { onclick: logout }, ["Log out"])]),
      ),
    ]);
    app.innerHTML = "";
    app.appendChild(el("div", { class: "shell" }, [sidebar, el("div", { class: "main" }, [contentNode])]));
  }

  function logout() {
    clearToken();
    currentUser = null;
    location.hash = "#/login";
  }

  // --- Login ------------------------------------------------------------

  function renderLogin() {
    let errorMsg = "";
    function draw() {
      app.innerHTML = "";
      const form = el(
        "form",
        {
          class: "login-screen",
          onsubmit: async (e) => {
            e.preventDefault();
            const email = form.querySelector("#email").value.trim();
            const password = form.querySelector("#password").value;
            try {
              const data = await api("POST", "/api/v1/auth/login", { email, password });
              if (!data.user || data.user.role !== "admin") {
                errorMsg = "This account doesn't have admin access.";
                draw();
                return;
              }
              setToken(data.tokens.accessToken);
              currentUser = data.user;
              location.hash = "#/staff";
            } catch (err) {
              errorMsg = err.message || "Login failed.";
              draw();
            }
          },
        },
        [
          el("h1", {}, ["Admin Console"]),
          el("p", { class: "sub" }, ["Sign in with your Katkee admin account."]),
          errorMsg ? el("div", { class: "error" }, [errorMsg]) : null,
          el("input", { id: "email", type: "email", placeholder: "Email", required: "required" }),
          el("input", { id: "password", type: "password", placeholder: "Password", required: "required" }),
          el("button", { type: "submit" }, ["Sign in"]),
        ],
      );
      app.appendChild(form);
    }
    draw();
  }

  // --- Staff / permissions ------------------------------------------------

  const ALL_PERMISSIONS_CACHE = { list: null };

  async function permissionsCatalog() {
    if (!ALL_PERMISSIONS_CACHE.list) {
      const data = await api("GET", "/api/v1/admin/console/permissions/catalog");
      ALL_PERMISSIONS_CACHE.list = data.permissions;
    }
    return ALL_PERMISSIONS_CACHE.list;
  }

  async function renderStaff() {
    const content = el("div", {}, ["Loading…"]);
    renderShell("staff", content);
    try {
      const [{ admins }, catalog] = await Promise.all([api("GET", "/api/v1/admin/console/admins"), permissionsCatalog()]);
      content.innerHTML = "";
      content.appendChild(el("h1", {}, ["Admins & Permissions"]));

      content.appendChild(
        el("div", { class: "card" }, [
          el("h3", {}, ["Create a new admin"]),
          el("p", { class: "muted" }, ["Requires the admins.create permission. Grants the existing 'admin' role — never SUPER_ADMIN."]),
          (() => {
            const form = el(
              "form",
              {
                class: "row",
                onsubmit: async (e) => {
                  e.preventDefault();
                  const username = form.querySelector("input").value.trim();
                  try {
                    await api("POST", "/api/v1/admin/console/admins", { username });
                    showToast("Admin created.");
                    renderStaff();
                  } catch (err) {
                    showToast(err.message, true);
                  }
                },
              },
              [el("input", { placeholder: "username", style: "max-width:220px" }), el("button", { type: "submit" }, ["Create admin"])],
            );
            return form;
          })(),
        ]),
      );

      for (const admin of admins) {
        content.appendChild(renderAdminCard(admin, catalog));
      }
    } catch (err) {
      content.innerHTML = "";
      content.appendChild(el("div", { class: "error" }, [err.message]));
    }
  }

  function renderAdminCard(admin, catalog) {
    const chips = el(
      "div",
      { class: "perm-list" },
      admin.isPrimaryAdmin
        ? [el("span", { class: "perm-chip" }, ["ALL (super admin)"])]
        : admin.permissions.map((p) =>
            el("span", { class: "perm-chip" }, [
              p + " ",
              el("a", { style: "cursor:pointer;color:inherit;text-decoration:underline", onclick: () => revokePermission(admin.username, p) }, ["×"]),
            ]),
          ),
    );

    const grantRow = admin.isPrimaryAdmin
      ? null
      : (() => {
          const select = el("select", { style: "max-width:220px;display:inline-block;margin-right:8px" }, catalog.map((p) => el("option", { value: p }, [p])));
          return el("div", { class: "row" }, [
            select,
            el("button", { class: "secondary", onclick: () => grantPermission(admin.username, select.value) }, ["Grant"]),
            el("button", { class: "danger", onclick: () => disableAdmin(admin.username) }, ["Disable admin"]),
          ]);
        })();

    return el("div", { class: "card" }, [
      el("h3", {}, [admin.displayName, " ", el("span", { class: "muted" }, ["@" + admin.username])]),
      chips,
      grantRow,
    ]);
  }

  async function grantPermission(username, permission) {
    try {
      await api("POST", "/api/v1/admin/console/admins/" + encodeURIComponent(username) + "/permissions", { permission });
      showToast("Permission granted.");
      renderStaff();
    } catch (err) {
      showToast(err.message, true);
    }
  }
  async function revokePermission(username, permission) {
    try {
      await api("DELETE", "/api/v1/admin/console/admins/" + encodeURIComponent(username) + "/permissions/" + encodeURIComponent(permission));
      showToast("Permission revoked.");
      renderStaff();
    } catch (err) {
      showToast(err.message, true);
    }
  }
  async function disableAdmin(username) {
    if (!confirm("Disable admin access for @" + username + "?")) return;
    try {
      await api("POST", "/api/v1/admin/console/admins/" + encodeURIComponent(username) + "/disable");
      showToast("Admin disabled.");
      renderStaff();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // --- Moderation queue ----------------------------------------------------

  async function renderModeration() {
    const content = el("div", {}, ["Loading…"]);
    renderShell("moderation", content);
    try {
      const { reports } = await api("GET", "/api/v1/moderation/reports?status=pending&limit=50");
      content.innerHTML = "";
      content.appendChild(el("h1", {}, ["Moderation Queue"]));
      content.appendChild(el("p", { class: "muted" }, [reports.length + " pending report(s)."]));
      for (const report of reports) content.appendChild(renderReportCard(report));
      if (reports.length === 0) content.appendChild(el("p", { class: "muted" }, ["Nothing pending. ✨"]));
    } catch (err) {
      content.innerHTML = "";
      content.appendChild(el("div", { class: "error" }, [err.message]));
    }
  }

  function describeTarget(report) {
    const t = report.target;
    if (t.type === "user") return "User @" + t.username + (t.isActive ? "" : " (already suspended)");
    if (t.type === "story") return "Story by @" + t.ownerUsername + (t.deleted ? " (already removed)" : "");
    if (t.type === "comment") return 'Comment by @' + t.authorUsername + ': "' + t.body + '"' + (t.deleted ? " (already removed)" : "");
    return "Unknown target";
  }

  function renderReportCard(report) {
    async function resolve(action) {
      const note = prompt("Optional note for this resolution:") || undefined;
      try {
        await api("POST", "/api/v1/moderation/reports/" + report.id + "/resolve", { action, note });
        showToast("Report resolved.");
        renderModeration();
      } catch (err) {
        showToast(err.message, true);
      }
    }
    const actions = [el("button", { class: "secondary", onclick: () => resolve("dismiss") }, ["Keep / Dismiss"])];
    if (report.targetType === "story" || report.targetType === "comment") {
      actions.push(el("button", { class: "danger", onclick: () => resolve("remove_content") }, ["Remove content"]));
    }
    if (report.targetType === "user") {
      actions.push(el("button", { class: "danger", onclick: () => resolve("suspend_user") }, ["Suspend user"]));
    }
    return el("div", { class: "card" }, [
      el("div", { class: "row" }, [badge(report.reason), el("span", { class: "muted" }, [new Date(report.createdAt).toLocaleString()])]),
      el("p", {}, [describeTarget(report)]),
      report.details ? el("p", { class: "muted" }, ['"' + report.details + '"']) : null,
      el("p", { class: "muted" }, ["Reported by @" + report.reporter.username]),
      el("div", { class: "row" }, actions),
    ]);
  }

  // --- Moderation history --------------------------------------------------

  async function renderModerationHistory() {
    const content = el("div", {}, ["Loading…"]);
    renderShell("moderation-history", content);
    try {
      const { entries } = await api("GET", "/api/v1/admin/console/moderation-history?limit=50");
      content.innerHTML = "";
      content.appendChild(el("h1", {}, ["Moderation History"]));
      const table = el("table", {}, [
        el("thead", {}, [el("tr", {}, [el("th", {}, ["When"]), el("th", {}, ["Action"]), el("th", {}, ["Target"]), el("th", {}, ["Reason"])])]),
        el(
          "tbody",
          {},
          entries.map((e) =>
            el("tr", {}, [
              el("td", {}, [new Date(e.createdAt).toLocaleString()]),
              el("td", {}, [e.actionType]),
              el("td", {}, [e.targetType + " " + e.targetId.slice(0, 8)]),
              el("td", {}, [e.reason || "—"]),
            ]),
          ),
        ),
      ]);
      content.appendChild(table);
    } catch (err) {
      content.innerHTML = "";
      content.appendChild(el("div", { class: "error" }, [err.message]));
    }
  }

  // --- Audit log ------------------------------------------------------------

  async function renderAudit() {
    const content = el("div", {}, ["Loading…"]);
    renderShell("audit", content);
    try {
      const { entries } = await api("GET", "/api/v1/admin/console/audit-logs?limit=50");
      content.innerHTML = "";
      content.appendChild(el("h1", {}, ["Audit Log"]));
      content.appendChild(el("p", { class: "muted" }, ["Append-only. Nothing here can ever be edited or deleted through this console."]));
      const table = el("table", {}, [
        el("thead", {}, [el("tr", {}, [el("th", {}, ["When"]), el("th", {}, ["Action"]), el("th", {}, ["Target"])])]),
        el(
          "tbody",
          {},
          entries.map((e) =>
            el("tr", {}, [
              el("td", {}, [new Date(e.createdAt).toLocaleString()]),
              el("td", {}, [e.action]),
              el("td", {}, [e.targetType ? e.targetType + " " + (e.targetId || "").slice(0, 8) : "—"]),
            ]),
          ),
        ),
      ]);
      content.appendChild(table);
    } catch (err) {
      content.innerHTML = "";
      content.appendChild(el("div", { class: "error" }, [err.message]));
    }
  }

  // --- Feature flags ----------------------------------------------------

  async function renderFlags() {
    const content = el("div", {}, ["Loading…"]);
    renderShell("flags", content);
    try {
      const { flags } = await api("GET", "/api/v1/admin/console/flags");
      content.innerHTML = "";
      content.appendChild(el("h1", {}, ["Feature Flags"]));
      content.appendChild(el("p", { class: "muted" }, ["Super-admin only. Takes effect on the very next request — no cache, no redeploy."]));
      for (const flag of flags) {
        content.appendChild(
          el("div", { class: "card row" }, [
            el("strong", { style: "flex:1" }, [flag.key]),
            badge(flag.enabled ? "active" : "paused"),
            el(
              "button",
              {
                class: "secondary",
                onclick: async () => {
                  try {
                    await api("POST", "/api/v1/admin/console/flags/" + flag.key, { enabled: !flag.enabled });
                    renderFlags();
                  } catch (err) {
                    showToast(err.message, true);
                  }
                },
              },
              [flag.enabled ? "Disable" : "Enable"],
            ),
          ]),
        );
      }
    } catch (err) {
      content.innerHTML = "";
      content.appendChild(el("div", { class: "error" }, [err.message]));
    }
  }

  // --- Advertising --------------------------------------------------------

  async function renderAds() {
    const content = el("div", {}, ["Loading…"]);
    renderShell("ads", content);
    try {
      const [{ campaigns }, { advertisers }, { settings }] = await Promise.all([
        api("GET", "/api/v1/admin/console/ads/campaigns"),
        api("GET", "/api/v1/admin/console/ads/advertisers"),
        api("GET", "/api/v1/admin/console/ads/settings"),
      ]);
      content.innerHTML = "";
      content.appendChild(el("h1", {}, ["Advertising"]));

      content.appendChild(
        el("div", { class: "card" }, [
          el("h3", {}, ["Frequency capping"]),
          el("p", { class: "muted" }, ["Server-configurable — never hard-coded. Applies to every Home feed request."]),
          (() => {
            const spacing = el("input", { type: "number", min: "0", value: settings.minOrganicBetweenAds, style: "max-width:100px;display:inline-block" });
            const cap = el("input", { type: "number", min: "0", value: settings.maxAdsPerSession, style: "max-width:100px;display:inline-block" });
            return el("div", { class: "row" }, [
              el("label", {}, ["Organic entries between ads: "]),
              spacing,
              el("label", {}, ["Max ads per feed load: "]),
              cap,
              el(
                "button",
                {
                  onclick: async () => {
                    try {
                      await api("POST", "/api/v1/admin/console/ads/settings", {
                        minOrganicBetweenAds: Number(spacing.value),
                        maxAdsPerSession: Number(cap.value),
                      });
                      showToast("Saved.");
                    } catch (err) {
                      showToast(err.message, true);
                    }
                  },
                },
                ["Save"],
              ),
            ]);
          })(),
        ]),
      );

      content.appendChild(
        el("div", { class: "card" }, [
          el("h3", {}, ["New advertiser"]),
          (() => {
            const form = el(
              "form",
              {
                class: "row",
                onsubmit: async (e) => {
                  e.preventDefault();
                  const name = form.querySelector("input").value.trim();
                  try {
                    await api("POST", "/api/v1/admin/console/ads/advertisers", { name });
                    showToast("Advertiser created.");
                    renderAds();
                  } catch (err) {
                    showToast(err.message, true);
                  }
                },
              },
              [el("input", { placeholder: "Advertiser name", style: "max-width:220px" }), el("button", { type: "submit" }, ["Create"])],
            );
            return form;
          })(),
        ]),
      );

      content.appendChild(
        el("div", { class: "card" }, [
          el("h3", {}, ["New campaign"]),
          advertisers.length === 0
            ? el("p", { class: "muted" }, ["Create an advertiser first."])
            : (() => {
                const advSelect = el("select", { style: "max-width:220px;display:inline-block;margin-right:8px" }, advertisers.map((a) => el("option", { value: a.id }, [a.name])));
                const nameInput = el("input", { placeholder: "Campaign name", style: "max-width:220px;display:inline-block;margin-right:8px" });
                return el("div", { class: "row" }, [
                  advSelect,
                  nameInput,
                  el(
                    "button",
                    {
                      onclick: async () => {
                        try {
                          await api("POST", "/api/v1/admin/console/ads/campaigns", { advertiserId: advSelect.value, name: nameInput.value.trim() });
                          showToast("Campaign created as a draft.");
                          renderAds();
                        } catch (err) {
                          showToast(err.message, true);
                        }
                      },
                    },
                    ["Create draft campaign"],
                  ),
                ]);
              })(),
        ]),
      );

      for (const campaign of campaigns) content.appendChild(renderCampaignCard(campaign));
    } catch (err) {
      content.innerHTML = "";
      content.appendChild(el("div", { class: "error" }, [err.message]));
    }
  }

  function renderCampaignCard(campaign) {
    async function action(path, body) {
      try {
        await api("POST", "/api/v1/admin/console/ads/campaigns/" + campaign.id + "/" + path, body);
        showToast("Done.");
        renderAds();
      } catch (err) {
        showToast(err.message, true);
      }
    }
    const buttons = [];
    if (campaign.status === "draft") {
      buttons.push(el("button", { class: "secondary", onclick: () => addCreativeFlow(campaign.id) }, ["Add creative"]));
      buttons.push(el("button", { onclick: () => action("submit") }, ["Submit for review"]));
    }
    if (campaign.status === "pending_review") {
      buttons.push(el("button", { onclick: () => action("approve") }, ["Approve"]));
      buttons.push(
        el(
          "button",
          {
            class: "danger",
            onclick: () => {
              const reason = prompt("Reason for rejecting this campaign:");
              if (reason) action("reject", { reason });
            },
          },
          ["Reject"],
        ),
      );
    }
    if (campaign.status === "approved" || campaign.status === "paused") {
      buttons.push(el("button", { onclick: () => action("activate") }, ["Activate"]));
    }
    if (campaign.status === "active") {
      buttons.push(el("button", { class: "secondary", onclick: () => action("pause") }, ["Pause"]));
      buttons.push(el("button", { class: "danger", onclick: () => action("complete") }, ["Mark completed"]));
    }
    buttons.push(el("button", { class: "secondary", onclick: () => showCampaignAnalytics(campaign.id) }, ["Analytics"]));

    return el("div", { class: "card" }, [
      el("div", { class: "row" }, [el("strong", {}, [campaign.name]), badge(campaign.status)]),
      campaign.rejectionReason ? el("p", { class: "muted" }, ["Rejected: " + campaign.rejectionReason]) : null,
      el("div", { class: "row" }, buttons),
    ]);
  }

  async function addCreativeFlow(campaignId) {
    const mediaId = prompt("Media ID (upload via POST /api/v1/media/photos as this admin, then paste its id here):");
    if (!mediaId) return;
    const headline = prompt("Headline:");
    if (!headline) return;
    const ctaUrl = prompt("Destination URL (https://…):");
    if (!ctaUrl) return;
    try {
      await api("POST", "/api/v1/admin/console/ads/campaigns/" + campaignId + "/creatives", { mediaId, headline, ctaUrl, ctaLabel: "Learn More", bodyText: "" });
      showToast("Creative added.");
      renderAds();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function showCampaignAnalytics(campaignId) {
    try {
      const { analytics } = await api("GET", "/api/v1/admin/console/ads/campaigns/" + campaignId + "/analytics");
      alert(
        "Impressions: " + analytics.impressions + "\nClicks: " + analytics.clicks + "\nHidden: " + analytics.hides + "\nReported: " + analytics.reports,
      );
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // --- Router ---------------------------------------------------------------

  const VIEWS = {
    staff: renderStaff,
    moderation: renderModeration,
    "moderation-history": renderModerationHistory,
    audit: renderAudit,
    flags: renderFlags,
    ads: renderAds,
  };

  async function route() {
    const hash = (location.hash || "#/staff").replace(/^#\//, "");
    if (hash === "login" || !getToken()) {
      renderLogin();
      return;
    }
    if (!currentUser) {
      try {
        const { user } = await api("GET", "/api/v1/auth/me");
        if (user.role !== "admin") {
          showToast("This account doesn't have admin access.", true);
          logout();
          return;
        }
        currentUser = user;
      } catch {
        renderLogin();
        return;
      }
    }
    const view = VIEWS[hash] || renderStaff;
    view();
  }

  window.addEventListener("hashchange", route);
  route();
})();
