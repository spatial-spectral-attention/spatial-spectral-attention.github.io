(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- theme ---------- */
  var toggle = $('#theme-toggle');
  if (toggle) toggle.addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
  });

  /* ---------- "Attention" reveal ---------- */
  var redact = $('#redact');
  if (redact) setTimeout(function () { redact.classList.add('revealed'); }, reduceMotion ? 0 : 900);

  /* ---------- maths ---------- */
  function renderMath() {
    if (!window.katex) return;
    var opts = { throwOnError: false, trust: true, strict: false };
    $$('.math').forEach(function (el) { katex.render(el.textContent, el, opts); });
    $$('.equation').forEach(function (el) {
      katex.render(el.getAttribute('data-display'), el, Object.assign({ displayMode: true }, opts));
    });
  }
  if (window.katex) renderMath();
  else window.addEventListener('load', renderMath);

  /* ---------- interactive teaser ---------- */
  var teaser = $('#teaser-frame');
  var start = $('#teaser-start');
  var teaserStatus = $('#teaser-status');
  teaser.hidden = false;
  start.addEventListener('click', function () {
    var viewer = document.createElement('iframe');
    viewer.title = 'Interactive cortical correspondence teaser';
    viewer.setAttribute('aria-describedby', 'teaser-caption');
    viewer.src = 'static/teaser/02-teaser/index.html';
    viewer.className = 'teaser-viewer';
    viewer.style.visibility = 'hidden';
    start.disabled = true;
    teaserStatus.textContent = 'Loading 3D surfaces…';

    function finish(ok) {
      clearTimeout(timeout);
      window.removeEventListener('message', onViewerMessage);
      if (ok) {
        viewer.style.visibility = '';
        teaser.classList.add('is-ready');
        if (document.activeElement === start || document.activeElement === document.body) viewer.focus();
        teaserStatus.textContent = '';
      } else {
        viewer.remove();
        start.disabled = false;
        teaserStatus.textContent = 'Could not load the interactive teaser.';
      }
    }

    function onViewerMessage(event) {
      if (event.source !== viewer.contentWindow || event.origin !== location.origin) return;
      if (event.data === 'cortex-teaser-ready') finish(true);
      if (event.data === 'cortex-teaser-error') finish(false);
    }

    var timeout = setTimeout(function () { finish(false); }, 45000);
    window.addEventListener('message', onViewerMessage);
    teaser.appendChild(viewer);
  });

  /* ---------- Geo-FlashAttention ---------- */
  var geoDemo = $('#geoflash-demo');
  var geoRetry = $('#geoflash-retry');
  var geoStatus = $('#geoflash-status');
  geoDemo.hidden = false;
  function loadGeoflash() {
    geoRetry.hidden = true;
    var frame = document.createElement('iframe');
    frame.title = 'Geo-FlashAttention on the cortex';
    frame.src = 'static/teaser/04-geoflash/index.html';
    frame.hidden = true;
    geoStatus.textContent = 'Loading 3D surfaces…';

    function fail() {
      clearTimeout(timeout);
      window.removeEventListener('message', onDemoMessage);
      frame.remove();
      geoRetry.hidden = false;
      geoStatus.textContent = 'Could not load the 3D demo.';
    }

    function onDemoMessage(event) {
      if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
      var data = event.data;
      if (!data || data.demo !== 'geoflash') return;
      if (data.type === 'error') {
        fail();
      } else if ((data.type === 'ready' || data.type === 'resize') && Number.isFinite(data.height)) {
        frame.style.height = data.height + 'px';
        if (data.type === 'ready') {
          clearTimeout(timeout);
          frame.hidden = false;
          geoDemo.classList.add('is-ready');
          geoStatus.textContent = '';
        }
      }
    }

    var timeout = setTimeout(fail, 45000);
    window.addEventListener('message', onDemoMessage);
    geoDemo.appendChild(frame);
  }

  geoRetry.addEventListener('click', loadGeoflash);
  if ('IntersectionObserver' in window) {
    var geoObserver = new IntersectionObserver(function (entries) {
      if (!entries.some(function (entry) { return entry.isIntersecting; })) return;
      geoObserver.disconnect();
      loadGeoflash();
    }, { rootMargin: '400px 0px' });
    geoObserver.observe(geoDemo);
  } else {
    loadGeoflash();
  }

  /* ---------- figure zoom ---------- */
  var dialog = $('#figure-dialog');
  if (dialog && dialog.showModal) {
    var dimg = $('img', dialog);
    $$('.zoomable').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var img = $('img', a);
        dimg.src = img.src; dimg.alt = img.alt;
        dialog.showModal();
      });
    });
    $('.dialog-close', dialog).addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });
  }

  /* ---------- BibTeX ---------- */
  var copy = $('#copy-bibtex');
  if (copy) copy.addEventListener('click', function () {
    var status = $('#copy-status');
    navigator.clipboard.writeText($('#bibtex').textContent).then(
      function () { status.textContent = 'Copied to clipboard.'; },
      function () { status.textContent = 'Select the text above to copy.'; });
    setTimeout(function () { status.textContent = ''; }, 2500);
  });
})();
