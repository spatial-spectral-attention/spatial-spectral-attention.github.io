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

  /* ---------- teaser player ---------- */
  var frame = $('#teaser-player');
  var video = $('#teaser-video');
  if (frame && video) {
    // Smaller file on small screens.
    if (window.innerWidth * (window.devicePixelRatio || 1) < 1400) {
      video.querySelector('source').src = video.dataset.srcSd;
      video.load();
    }
    var seek = $('#video-seek'), fill = $('#seek-fill'), time = $('#video-time');
    var chapters = $$('.chapters button');
    var dur = function () { return video.duration || 24.5; };
    var fmt = function (t) { t = Math.max(0, Math.floor(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };

    var play = function () { var p = video.play(); if (p && p.catch) p.catch(function () {}); };
    var togglePlay = function () { video.paused ? play() : video.pause(); };
    video.addEventListener('play', function () { frame.classList.add('playing'); });
    video.addEventListener('pause', function () { frame.classList.remove('playing'); });
    video.addEventListener('click', togglePlay);
    $('#video-start').addEventListener('click', play);
    $('#video-toggle').addEventListener('click', togglePlay);

    video.addEventListener('timeupdate', function () {
      var t = video.currentTime;
      fill.style.width = (100 * t / dur()) + '%';
      time.textContent = fmt(t);
      seek.setAttribute('aria-valuenow', t.toFixed(1));
      chapters.forEach(function (b) {
        b.classList.toggle('is-active', t >= +b.dataset.t && t < +b.dataset.end);
      });
    });

    var scrubTo = function (e) {
      var r = seek.getBoundingClientRect();
      var x = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
      video.currentTime = x * dur();
    };
    seek.addEventListener('pointerdown', function (e) {
      seek.setPointerCapture(e.pointerId); scrubTo(e);
      var move = function (ev) { scrubTo(ev); };
      seek.addEventListener('pointermove', move);
      seek.addEventListener('pointerup', function up() {
        seek.removeEventListener('pointermove', move); seek.removeEventListener('pointerup', up);
      });
    });
    seek.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { video.currentTime = Math.min(dur(), video.currentTime + 1); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { video.currentTime = Math.max(0, video.currentTime - 1); e.preventDefault(); }
      if (e.key === ' ') { togglePlay(); e.preventDefault(); }
    });

    chapters.forEach(function (b) {
      b.addEventListener('click', function () { video.currentTime = +b.dataset.t + 0.01; play(); });
    });

    $('#video-fullscreen').addEventListener('click', function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (frame.requestFullscreen) frame.requestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    });

    // Autoplay (muted) while in view; pause when scrolled away. A manual pause sticks.
    var userPaused = false;
    $('#video-toggle').addEventListener('click', function () { userPaused = video.paused; });
    if (!reduceMotion && 'IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting && !userPaused) play();
          else if (!en.isIntersecting) video.pause();
        });
      }, { threshold: 0.45 }).observe(frame);
    }
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
