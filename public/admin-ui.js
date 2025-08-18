// /public/admin-ui.js  (BROWSER FILE)
(function () {
  // Persist the admin bearer in sessionStorage after a successful admin login
  // Call this from your login success branch when role === 'admin'
  window.__rememberAdminPass = function (password) {
    try {
      const token = "Bearer:super:" + String(password || "");
      sessionStorage.setItem("ADMIN_BEARER", token);
      return token;
    } catch { return null; }
  };

  function getBearer() {
    try { return sessionStorage.getItem("ADMIN_BEARER"); } catch { return null; }
  }

  // Reset Spins button
  function wireResetSpins() {
    const btn = document.getElementById("reset-spins-btn");
    const status = document.getElementById("reset-spins-status");
    if (!btn) return;

    btn.addEventListener("click", async () => {
      try {
        let bearer = getBearer();
        if (!bearer) {
          const pwd = prompt("Enter admin password to reset spins:");
          if (!pwd) return;
          bearer = "Bearer:super:" + pwd;
          sessionStorage.setItem("ADMIN_BEARER", bearer);
        }

        btn.disabled = true;
        if (status) status.textContent = "Resetting…";

        const res = await fetch("/api/admin?action=reset-slot-spins", {
          method: "POST",
          headers: { Authorization: bearer },
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j?.success) throw new Error(j?.error || "reset failed");

        if (status) status.textContent = `Done (version ${j.version})`;
        setTimeout(() => { if (status) status.textContent = ""; }, 4000);
      } catch (e) {
        if (status) status.textContent = "Failed";
        alert("Reset spins failed: " + (e?.message || e));
      } finally {
        btn.disabled = false;
      }
    });
  }

  // Optional: Winners log “manual add” form wiring (if you’re using it)
  function wireWinnerLogForm() {
    const nameIn   = document.getElementById("wl-name");
    const prizeIn  = document.getElementById("wl-prize");
    const saveBtn  = document.getElementById("wl-save");
    const statusEl = document.getElementById("wl-status");
    const tbody    = document.querySelector("#wl-table tbody");

    if (!saveBtn) return;

    async function refreshWinners() {
      if (!tbody) return;
      try {
        const r = await fetch("/api/admin?action=winner-logs&_=" + Date.now(), { cache: "no-store" });
        const j = await r.json().catch(()=>({ rows: [] }));
        const rows = Array.isArray(j.rows) ? j.rows : [];
        tbody.innerHTML = rows.map(row => {
          const when = new Date(row.ts).toLocaleString();
          const name = (row.name || "").replace(/</g,"&lt;").replace(/>/g,"&gt;");
          const prize = (row.prize || "").replace(/</g,"&lt;").replace(/>/g,"&gt;");
          const source = (row.source || "");
          return `<tr>
            <td style="padding:.5rem;border-bottom:1px solid #f3f3f3">${when}</td>
            <td style="padding:.5rem;border-bottom:1px solid #f3f3f3">${name}</td>
            <td style="padding:.5rem;border-bottom:1px solid #f3f3f3">${prize || "<em>(tbd)</em>"}</td>
            <td style="padding:.5rem;border-bottom:1px solid #f3f3f3">${source}</td>
          </tr>`;
        }).join("");
      } catch {
        if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="padding:.75rem;color:#999">Failed to load logs</td></tr>`;
      }
    }

    saveBtn.addEventListener("click", async () => {
      try {
        const name  = (nameIn?.value || "").trim();
        const prize = (prizeIn?.value || "").trim();
        if (!name || !prize) { alert("Please fill in both name and prize."); return; }

        let bearer = sessionStorage.getItem("ADMIN_BEARER");
        if (!bearer) {
          const pwd = prompt("Enter admin password to log a winner:");
          if (!pwd) return;
          bearer = "Bearer:super:" + pwd;
          sessionStorage.setItem("ADMIN_BEARER", bearer);
        }

        saveBtn.disabled = true;
        if (statusEl) statusEl.textContent = "Saving…";

        const res = await fetch("/api/admin?action=winner-log", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: bearer },
          body: JSON.stringify({ name, prize }),
        });
        const j = await res.json().catch(()=>({}));
        if (!res.ok || !j?.success) throw new Error(j?.error || "save failed");

        if (statusEl) statusEl.textContent = "Saved!";
        if (prizeIn) prizeIn.value = "";
        await refreshWinners();
        setTimeout(() => { if (statusEl) statusEl.textContent = ""; }, 2500);
      } catch (e) {
        if (statusEl) statusEl.textContent = "Failed";
        alert("Could not log winner: " + (e?.message || e));
      } finally {
        saveBtn.disabled = false;
      }
    });

    // Initial load + periodic refresh
    refreshWinners();
    setInterval(refreshWinners, 20_000);
  }

  // Boot
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      wireResetSpins();
      wireWinnerLogForm();
    }, { once: true });
  } else {
    wireResetSpins();
    wireWinnerLogForm();
  }
})();
