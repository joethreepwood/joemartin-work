/* Minimal dependency-free carousel.
   Native scroll-snap does the sliding; this wires up the
   prev/next buttons, dot indicators and keyboard arrows,
   and keeps them in sync as you scroll/swipe. */
(function () {
  document.querySelectorAll('[data-carousel]').forEach(function (root) {
    var track = root.querySelector('[data-track]');
    var slides = Array.prototype.slice.call(track.children);
    var prev = root.querySelector('[data-prev]');
    var next = root.querySelector('[data-next]');
    var dotsWrap = root.querySelector('[data-dots]');
    if (!track || slides.length < 2) return;

    var current = 0;

    // Build a dot per slide
    var dots = slides.map(function (_, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'carousel__dot';
      b.setAttribute('aria-label', 'Go to screenshot ' + (i + 1));
      b.addEventListener('click', function () { go(i); });
      dotsWrap.appendChild(b);
      return b;
    });

    function slideX(i) { return slides[i].offsetLeft - track.offsetLeft; }

    function go(i) {
      current = Math.max(0, Math.min(slides.length - 1, i));
      track.scrollTo({ left: slideX(current), behavior: 'smooth' });
    }

    function sync() {
      // find the slide nearest the current scroll position
      var x = track.scrollLeft, best = Infinity, nearest = 0;
      slides.forEach(function (s, i) {
        var d = Math.abs(slideX(i) - x);
        if (d < best) { best = d; nearest = i; }
      });
      current = nearest;
      dots.forEach(function (d, i) {
        d.setAttribute('aria-current', i === current ? 'true' : 'false');
      });
      if (prev) prev.disabled = current === 0;
      if (next) next.disabled = current === slides.length - 1;
    }

    if (prev) prev.addEventListener('click', function () { go(current - 1); });
    if (next) next.addEventListener('click', function () { go(current + 1); });

    root.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(current - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(current + 1); }
    });

    var t;
    track.addEventListener('scroll', function () {
      clearTimeout(t);
      t = setTimeout(sync, 60);
    });
    window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(sync, 120); });

    root.classList.add('is-ready');
    sync();
  });
})();
