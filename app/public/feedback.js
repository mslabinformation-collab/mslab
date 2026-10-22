/**
 * MS LAB review comments. Loaded by the hub, every prototype page and (until launch) the main site's public pages and the signed-in admin's pages.
 * Floating button → panel (mood, mark a place on the page, text) → POST /api/feedback.
 * Opening a page with ?fb=<id> outlines the place a comment was left on.
 * Self-contained; never allowed to break the host page.
 */
(function () {
  "use strict";
  if (window.__mslabFeedback) return;
  window.__mslabFeedback = true;

  // Prototype /p/<dir>/ → its letter; the hub /guide → "hub"; a page whose <html> says data-fb-dir="admin" (the admin's root layout; the script is
  // loaded only on the signed-in pages of the admin, by the (panel) layout) → "admin"; any other page is the main site → "site".
  var DIR = (location.pathname.match(/^\/p\/([a-z0-9]+)\//) || [])[1] || (/^\/guide(\/|$)/.test(location.pathname) ? "hub" : document.documentElement.getAttribute("data-fb-dir") === "admin" ? "admin" : "site");
  var ROSE = "#9E8993";
  var CSS = [
    "#mslab-fb,#mslab-fb *{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:normal;text-transform:none}",
    "#mslab-fb .fb-fab{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;align-items:center;gap:8px;height:48px;padding:0 18px 0 14px;border:0;border-radius:999px;background:#222;color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 10px 28px -8px rgba(34,34,34,.55);transition:transform .25s,bottom .25s}",
    "#mslab-fb .fb-fab:hover{transform:translateY(-2px)}",
    "#mslab-fb .fb-fab svg{width:20px;height:20px}",
    "@media (max-width:600px){#mslab-fb .fb-fab{width:48px;padding:0;justify-content:center}#mslab-fb .fb-fab span{display:none}}",
    "#mslab-fb .fb-pn{position:fixed;right:16px;bottom:76px;z-index:2147483001;width:min(360px,calc(100vw - 32px));max-height:calc(100vh - 100px);overflow:auto;background:#fff;color:#222;border-radius:22px;padding:20px;box-shadow:0 30px 70px -20px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.05)}",
    "#mslab-fb .fb-hd{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}",
    "#mslab-fb .fb-hd b{display:block;font-size:17px;font-weight:600}",
    "#mslab-fb .fb-hd small{display:block;font-size:12px;color:#675D62;margin-top:3px}",
    "#mslab-fb .fb-x{width:36px;height:36px;flex:none;border-radius:50%;border:1px solid #E6E1E3;background:#fff;font-size:18px;line-height:1;cursor:pointer;color:#222}",
    "#mslab-fb input[type=text],#mslab-fb textarea{width:100%;border:1px solid #D5D0D3;border-radius:12px;padding:10px 12px;font-size:15px;color:#222;background:#F6F4F5;margin-top:12px;outline:none}",
    "#mslab-fb input[type=text]:focus,#mslab-fb textarea:focus{border-color:#222;background:#fff}",
    "#mslab-fb textarea{min-height:96px;resize:vertical;line-height:1.45}",
    "#mslab-fb .fb-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}",
    "#mslab-fb .fb-chip{min-height:36px;padding:0 14px;border-radius:999px;border:1px solid #E6E1E3;background:#fff;font-size:13px;font-weight:500;cursor:pointer;color:#222}",
    "#mslab-fb .fb-chip.fb-on{background:#222;border-color:#222;color:#fff}",
    "#mslab-fb .fb-pick{width:100%;min-height:44px;margin-top:12px;border-radius:12px;border:1.5px dashed " + ROSE + ";background:#fff;font-size:14px;font-weight:500;cursor:pointer;color:#222}",
    "#mslab-fb .fb-pick:hover{background:#F6F4F5}",
    "#mslab-fb .fb-pk{display:flex;align-items:center;gap:8px;margin-top:10px;padding:8px 10px;border-radius:10px;background:#F6F4F5;font-size:13px}",
    "#mslab-fb .fb-pk span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    "#mslab-fb .fb-pk button{border:0;background:none;cursor:pointer;font-size:14px;color:#675D62}",
    "#mslab-fb .fb-send{width:100%;min-height:48px;margin-top:14px;border:0;border-radius:999px;background:#222;color:#fff;font-size:15px;font-weight:600;cursor:pointer}",
    "#mslab-fb .fb-send[disabled]{opacity:.6;cursor:default}",
    "#mslab-fb .fb-err{margin-top:10px;font-size:13px;color:#8A3B3B}",
    "#mslab-fb .fb-ok{padding:26px 6px;text-align:center;font-size:16px;font-weight:600}",
    "#mslab-fb .fb-ok small{display:block;margin-top:6px;font-size:13px;font-weight:400;color:#675D62}",
    "#mslab-fb .fb-hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}",
    "#mslab-fb .fb-ov{position:fixed;inset:0;z-index:2147483002;cursor:crosshair}",
    "#mslab-fb .fb-bar{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483003;max-width:calc(100vw - 24px);padding:10px 16px;border-radius:999px;background:#222;color:#fff;font-size:13px;font-weight:500;box-shadow:0 10px 30px -10px rgba(0,0,0,.5);display:flex;gap:12px;align-items:center}",
    "#mslab-fb .fb-bar button{border:0;background:#fff;color:#222;border-radius:999px;min-height:30px;padding:0 12px;font-size:12px;font-weight:600;cursor:pointer}",
    "#mslab-fb .fb-hl{position:absolute;z-index:2147482999;pointer-events:none;border:2px solid " + ROSE + ";background:rgba(158,137,147,.14);border-radius:8px;transition:all .08s}",
    "#mslab-fb .fb-note{position:absolute;z-index:2147482999;max-width:300px;padding:12px 14px;border-radius:14px;background:#fff;color:#222;border:2px solid " + ROSE + ";font-size:13px;line-height:1.45;box-shadow:0 14px 34px -12px rgba(0,0,0,.5)}",
    "#mslab-fb .fb-note b{display:block;font-size:12px;color:#675D62;margin-bottom:4px;font-weight:600}",
    "#mslab-fb .fb-note button{position:absolute;top:6px;right:8px;border:0;background:none;color:#675D62;cursor:pointer;font-size:14px}",
    "body.viewing #mslab-fb{display:none}",
  ].join("\n");

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function squish(s) { return (s || "").replace(/\s+/g, " ").trim(); }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem("mslab-fb-" + k); localStorage.setItem("mslab-fb-" + k, v); } catch (e) { return null; } }
  function device() { var w = window.innerWidth; return w < 600 ? "mob" : w < 1000 ? "tab" : "desk"; }
  function docRect(el) { var r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }

  // Unique-ish CSS path from <body>, using ids where they exist.
  function selectorFor(el) {
    var parts = [];
    for (var n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id) && document.querySelectorAll("#" + n.id).length === 1) { parts.unshift("#" + n.id); break; }
      var i = 1, s = n;
      while ((s = s.previousElementSibling)) if (s.tagName === n.tagName) i++;
      parts.unshift(n.tagName.toLowerCase() + ":nth-of-type(" + i + ")");
    }
    if (parts.length && parts[0].charAt(0) !== "#") parts.unshift("body");
    return parts.join(" > ");
  }
  function labelFor(el) {
    var t = "";
    try {
      var sec = el.closest("section,article,header,footer,aside,nav,form,li,figure") || el;
      var hd = sec.querySelector("h1,h2,h3,h4");
      if (el.matches("h1,h2,h3,h4")) hd = el;
      if (hd) t = squish(hd.textContent);
      if (!t) t = squish(el.getAttribute("aria-label"));
      if (!t) t = squish(el.textContent);
    } catch (e) {}
    return t.slice(0, 70);
  }
  function titleFor() {
    var t = squish(document.title).replace(/\s+—\s+MS LAB.*$/, "");
    return t || undefined;
  }

  function init() {
    var st = h("style"); st.textContent = CSS; document.head.appendChild(st);
    var root = h("div"); root.id = "mslab-fb"; document.body.appendChild(root);

    var fab = h("button", "fb-fab");
    fab.type = "button";
    fab.setAttribute("aria-label", "Jäta kommentaar");
    fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg><span>Kommentaar</span>';
    root.appendChild(fab);

    var mood = null, picked = null, pickedEl = null, sending = false, panel = null, hl = null;

    // The button never covers the host page's own bottom-right UI: a prototype's .sticky-buy bar, and on the main site
    // anything marked [data-fab-avoid] while it is on screen (the copy/share toast, the newsletter notice and its "Liitu",
    // the campaign sheet, the works gallery's arrows). It moves up above the highest of them that shares its corner;
    // re-checked whenever the page changes or scrolls (once per frame).
    function liftFab() {
      var sb = document.querySelector(".sticky-buy");
      var lift = sb && sb.offsetHeight && getComputedStyle(sb).display !== "none" ? sb.offsetHeight + 12 : 16;
      var vh = window.innerHeight, fr = fab.getBoundingClientRect(), right = window.innerWidth - 16, left = right - Math.max(fr.width, 48);
      [].forEach.call(document.querySelectorAll("[data-fab-avoid]"), function (el) {
        var r = el.getBoundingClientRect();
        if (!r.width || !r.height || r.bottom <= 0 || r.top >= vh) return; // not on screen
        if (r.right <= left || r.left >= right || r.bottom < vh - lift - 48) return; // not in the button's corner
        lift = Math.max(lift, Math.round(vh - r.top + 12));
      });
      lift = Math.min(lift, Math.max(16, vh - 48 - 8)); // the button itself stays on screen
      fab.style.bottom = lift + "px";
      if (panel) panel.style.bottom = lift + 60 + "px";
    }
    var liftQueued = false;
    function queueLift() {
      if (liftQueued) return;
      liftQueued = true;
      requestAnimationFrame(function () { liftQueued = false; liftFab(); });
    }
    window.addEventListener("resize", queueLift);
    window.addEventListener("scroll", queueLift, { passive: true });
    window.addEventListener("hashchange", function () { setTimeout(liftFab, 300); });
    document.addEventListener("transitionend", queueLift, true);
    if (window.MutationObserver)
      new MutationObserver(function (list) {
        for (var i = 0; i < list.length; i++) if (!root.contains(list[i].target)) return queueLift();
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "open", "hidden", "data-on", "data-fab-avoid"] });
    setTimeout(liftFab, 600);

    function clearMark() { if (hl) { hl.remove(); hl = null; } pickedEl = null; }
    function markEl(el) {
      clearMark(); pickedEl = el;
      hl = h("div", "fb-hl"); root.appendChild(hl);
      var r = docRect(el);
      hl.style.cssText = "left:" + (r.x - 4) + "px;top:" + (r.y - 4) + "px;width:" + (r.w + 8) + "px;height:" + (r.h + 8) + "px";
    }

    function openPanel() {
      if (panel) return closePanel();
      panel = h("div", "fb-pn");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "Jäta kommentaar");
      var hd = h("div", "fb-hd");
      var tt = h("div"); tt.appendChild(h("b", null, "Jäta kommentaar")); tt.appendChild(h("small", null, "Kommentaar jõuab kohe arendajani."));
      var x = h("button", "fb-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Sulge"); x.onclick = closePanel;
      hd.appendChild(tt); hd.appendChild(x); panel.appendChild(hd);

      var name = h("input"); name.type = "text"; name.placeholder = "Sinu nimi"; name.value = store("name") || ""; name.setAttribute("aria-label", "Sinu nimi"); name.autocomplete = "name"; name.oninput = function () { store("name", name.value.trim()); };
      panel.appendChild(name);

      var chips = h("div", "fb-chips");
      [["good", "Meeldib"], ["bad", "Ei meeldi"], ["change", "Muuta"]].forEach(function (m) {
        var c = h("button", "fb-chip" + (mood === m[0] ? " on" : ""), m[1]); c.type = "button";
        c.onclick = function () { mood = mood === m[0] ? null : m[0]; [].forEach.call(chips.children, function (k) { k.classList.remove("fb-on"); }); if (mood) c.classList.add("fb-on"); };
        chips.appendChild(c);
      });
      panel.appendChild(chips);

      var pick = h("button", "fb-pick", picked ? "Märgi teine koht" : "📍 Märgi koht lehel"); pick.type = "button";
      pick.onclick = startPick; panel.appendChild(pick);
      if (picked) {
        var pk = h("div", "fb-pk"); pk.appendChild(h("span", null, "Koht: " + (picked.label || "valitud element")));
        var rm = h("button", null, "✕"); rm.type = "button"; rm.setAttribute("aria-label", "Eemalda koht");
        rm.onclick = function () { picked = null; clearMark(); rebuild(); };
        pk.appendChild(rm); panel.appendChild(pk);
      }

      var ta = h("textarea"); ta.placeholder = "Mida arvad? Võib lühidalt."; ta.setAttribute("aria-label", "Kommentaar"); ta.value = store("draft") || "";
      ta.oninput = function () { store("draft", ta.value); };
      panel.appendChild(ta);
      var hp = h("input", "fb-hp"); hp.type = "text"; hp.tabIndex = -1; hp.autocomplete = "off"; hp.setAttribute("aria-hidden", "true"); panel.appendChild(hp);
      var err = h("div", "fb-err"); err.hidden = true; panel.appendChild(err);
      var send = h("button", "fb-send", "Saada"); send.type = "button"; panel.appendChild(send);

      send.onclick = function () {
        if (sending) return;
        var text = ta.value.trim();
        if (!text) { ta.focus(); return; }
        sending = true; send.disabled = true; send.textContent = "Saadan…"; err.hidden = true;
        store("name", name.value.trim());
        var payload = {
          // prototypes route by hash (#/koolitused); a main-site or admin page is its path (the comment link opens it with ?fb=)
          dir: DIR, route: (DIR === "site" || DIR === "admin" ? location.pathname : location.hash) || undefined, title: titleFor(), device: device(), width: window.innerWidth,
          name: name.value.trim() || undefined, mood: mood || undefined, text: text, website: hp.value || undefined,
          el: picked || undefined,
        };
        fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
          .then(function () {
            sending = false; mood = null; picked = null; clearMark(); store("draft", "");
            panel.innerHTML = "";
            var ok = h("div", "fb-ok", "Aitäh! Kommentaar on saadetud ✓"); ok.appendChild(h("small", null, "Võid jätta nii palju kommentaare kui soovid."));
            panel.appendChild(ok);
            setTimeout(closePanel, 2200);
          })
          .catch(function () {
            sending = false; send.disabled = false; send.textContent = "Saada";
            err.textContent = "Ei õnnestunud saata — proovi uuesti."; err.hidden = false;
          });
      };
      root.appendChild(panel);
      liftFab();
      (picked ? ta : name.value ? ta : name).focus();
    }
    function closePanel() { if (panel) { panel.remove(); panel = null; } }
    function rebuild() { closePanel(); openPanel(); }
    fab.onclick = openPanel;

    // ---- pick mode: hover shows a box, click/tap selects ----
    function startPick() {
      closePanel();
      var ov = h("div", "fb-ov");
      var bar = h("div", "fb-bar"); bar.appendChild(h("span", null, "Vajuta kohale, mida kommentaar puudutab"));
      var cancel = h("button", null, "Tühista"); cancel.type = "button"; bar.appendChild(cancel);
      var box = h("div", "fb-hl"); box.style.display = "none";
      root.appendChild(box); root.appendChild(ov); root.appendChild(bar);
      function under(e) {
        var stack = document.elementsFromPoint(e.clientX, e.clientY) || [];
        for (var i = 0; i < stack.length; i++) {
          var n = stack[i];
          if (root.contains(n) || n === document.documentElement || n === document.body) continue;
          return n;
        }
        return null;
      }
      function end() { ov.remove(); bar.remove(); box.remove(); document.removeEventListener("keydown", onKey, true); }
      function onKey(e) { if (e.key === "Escape") { end(); openPanel(); } }
      ov.addEventListener("mousemove", function (e) {
        var el = under(e); if (!el) { box.style.display = "none"; return; }
        var r = docRect(el); box.style.cssText = "display:block;left:" + (r.x - 4) + "px;top:" + (r.y - 4) + "px;width:" + (r.w + 8) + "px;height:" + (r.h + 8) + "px";
      });
      ov.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        var el = under(e);
        end();
        if (el) {
          var r = docRect(el);
          picked = { label: labelFor(el) || undefined, snippet: squish(el.textContent).slice(0, 200) || undefined, sel: selectorFor(el), y: Math.round(r.y), h: Math.round(r.h) };
          // The admin's pages show students' names, e-mail addresses and phone numbers: only where the place is (the selector and the position)
          // goes with the comment, never the element's own words (they stay on the page; the server drops them as well).
          if (DIR === "admin") picked = { sel: picked.sel, y: picked.y, h: picked.h };
          markEl(el);
        }
        openPanel();
      });
      cancel.onclick = function () { end(); openPanel(); };
      document.addEventListener("keydown", onKey, true);
    }

    // ---- ?fb=<id>: show where a comment was left ----
    var fb = new URLSearchParams(location.search).get("fb");
    if (fb && /^[a-z0-9]{6,20}$/.test(fb) && DIR !== "hub") {
      fetch("/api/feedback/" + fb).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (!d || !d.ok) return;
        var tries = 0;
        (function find() {
          var el = null;
          try { el = d.el && d.el.sel ? document.querySelector(d.el.sel) : null; } catch (e) {}
          if (!el && ++tries < 12) return setTimeout(find, 400);
          var y;
          if (el) { markEl(el); el.scrollIntoView({ block: "center" }); y = docRect(el); }
          else if (d.el && typeof d.el.y === "number") { window.scrollTo(0, Math.max(0, d.el.y - 120)); y = { x: 16, y: d.el.y, w: 0, h: d.el.h || 0 }; }
          var note = h("div", "fb-note");
          note.appendChild(h("b", null, (d.name || "Kommentaar") + (el || !d.el || !d.el.sel ? "" : " · täpset kohta ei leitud")));
          note.appendChild(document.createTextNode(d.text));
          var c = h("button", null, "✕"); c.type = "button"; c.setAttribute("aria-label", "Sulge"); c.onclick = function () { note.remove(); clearMark(); };
          note.appendChild(c);
          root.appendChild(note);
          var top = y ? y.y + y.h + 10 : scrollY + 80;
          note.style.left = Math.max(12, Math.min((y ? y.x : 12), document.documentElement.clientWidth - 312)) + "px";
          note.style.top = top + "px";
        })();
      }).catch(function () {});
    }
  }

  function safe() { try { init(); } catch (e) { if (window.console) console.error("feedback init failed", e); } }
  if (document.body) safe(); else document.addEventListener("DOMContentLoaded", safe);
})();
