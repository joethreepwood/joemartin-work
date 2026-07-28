/* ============================================================
   PostHog analytics for joemartin.work (and Null Sector).

   Cookieless by design: no cookies, no localStorage, no consent
   banner. Visitors are counted with a privacy-preserving hash
   computed on PostHog's servers, which is why `identify()` is
   never called here — a distinct ID would be personal data.
   This only works because "cookieless server hash mode" is also
   enabled on the project; without it PostHog drops the events.

   Autocapture is off, so every event below is deliberate.
   Nothing here is allowed to break the page: if PostHog is
   blocked or slow, tracking degrades to a no-op.
   Loaded with `defer` on index.html and null-sector.html.
   ============================================================ */
(function () {
  'use strict';

  var KEY = 'phc_u8PDxqSCr5EcDkUYtSxqDczaB56cfDEKWacGN3JFmwLU';
  var API = 'https://us.i.posthog.com';
  var ASSETS = 'https://us-assets.i.posthog.com/static/array.js';

  var pending = [], ready = false;

  // The one entry point the rest of the site uses. Events raised before
  // the SDK has loaded queue up briefly rather than being lost.
  window.jmTrack = function (name, props) {
    if (!name) return;
    if (ready) {
      try { window.posthog.capture(name, props); } catch (e) { /* never break the page */ }
    } else if (pending.length < 60) {
      pending.push([name, props]);
    }
  };

  function flush() {
    ready = true;
    for (var i = 0; i < pending.length; i++) {
      try { window.posthog.capture(pending[i][0], pending[i][1]); } catch (e) {}
    }
    pending.length = 0;
  }

  var s = document.createElement('script');
  s.src = ASSETS;
  s.async = true;
  s.onload = function () {
    if (!window.posthog || !window.posthog.init) return;
    try {
      window.posthog.init(KEY, {
        api_host: API,
        defaults: '2026-05-30',
        cookieless_mode: 'always',   // no cookies or storage at all
        autocapture: false,          // we name our own events
        capture_exceptions: true     // JS errors → error tracking
      });
      flush();
    } catch (e) { pending.length = 0; }
  };
  s.onerror = function () { pending.length = 0; };   // blocked by an extension: stay quiet
  document.head.appendChild(s);

  // ---------- outbound clicks, per project section ----------
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var a = t.closest('a[href]');
    if (!a) return;

    var href = a.getAttribute('href') || '';
    var sec = a.closest('section.sec');
    var project = sec ? sec.id : null;

    if (/^https?:/i.test(href) && a.hostname && a.hostname !== location.hostname) {
      window.jmTrack('outbound_link_clicked', {
        url: href,
        link_text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        link_class: a.className || null,
        project: project
      });
    } else if (/(^|\/)game\.html/i.test(href)) {
      window.jmTrack('game_cta_clicked', { project: project, from: location.pathname });
    } else if (/^mailto:/i.test(href)) {
      window.jmTrack('email_clicked', { project: project, link_class: a.className || null });
    }
  }, true);

  // ---------- which project sections actually get seen ----------
  // A portfolio's most useful question is "how far down did they get?".
  // Fires at most once per section per pageview.
  if (window.IntersectionObserver) {
    var sections = document.querySelectorAll('section.sec[id]');
    if (sections.length) {
      var seen = {};
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var en = entries[i];
          if (!en.isIntersecting) continue;
          var id = en.target.id;
          if (seen[id]) continue;
          seen[id] = true;
          var label = en.target.querySelector('h2');
          window.jmTrack('project_section_viewed', {
            project: id,
            title: label ? label.textContent.trim().slice(0, 60) : null,
            position: Array.prototype.indexOf.call(sections, en.target) + 1
          });
          io.unobserve(en.target);
        }
      }, { threshold: 0.4 });
      Array.prototype.forEach.call(sections, function (el) { io.observe(el); });
    }
  }
})();
