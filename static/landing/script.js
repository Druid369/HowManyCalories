/* ════════════════════════════════════════════════
   СЪЕМ Landing — Interactions
   Scroll reveals, counter animations, custom cursor
════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Custom Cursor ──────────────────────── */
  const dot  = document.getElementById('curDot');
  const ring = document.getElementById('curRing');

  if (dot && ring && window.matchMedia('(hover: hover)').matches) {
    let mx = -100, my = -100;
    let rx = -100, ry = -100;

    document.addEventListener('mousemove', (e) => {
      mx = e.clientX;
      my = e.clientY;
      dot.style.left = mx + 'px';
      dot.style.top  = my + 'px';
    });

    // Smooth ring follow
    (function followRing() {
      rx += (mx - rx) * 0.15;
      ry += (my - ry) * 0.15;
      ring.style.left = rx + 'px';
      ring.style.top  = ry + 'px';
      requestAnimationFrame(followRing);
    })();

    // Enlarge ring on interactive elements
    document.querySelectorAll('[data-cursor="lg"], a, button').forEach((el) => {
      el.addEventListener('mouseenter', () => ring.classList.add('lg'));
      el.addEventListener('mouseleave', () => ring.classList.remove('lg'));
    });

    // Hide cursor when leaving window
    document.addEventListener('mouseleave', () => {
      dot.style.opacity = '0';
      ring.style.opacity = '0';
    });
    document.addEventListener('mouseenter', () => {
      dot.style.opacity = '1';
      ring.style.opacity = '1';
    });
  }

  /* ── Scroll Reveal ─────────────────────── */
  const revealElements = document.querySelectorAll('[data-reveal]');

  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const delay = parseInt(entry.target.dataset.delay || '0', 10);
          setTimeout(() => {
            entry.target.classList.add('visible');
          }, delay);
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
  );

  revealElements.forEach((el) => revealObserver.observe(el));

  /* ── Counter Animation ─────────────────── */
  const counterElements = document.querySelectorAll('[data-count]');

  function animateCounter(el) {
    const target = parseInt(el.dataset.count, 10);
    const prefix = el.dataset.prefix || '';
    const suffix = el.dataset.suffix || '';
    const duration = 1800;
    const start = performance.now();

    function formatNumber(n) {
      if (n >= 10000) return n.toLocaleString('ru-RU');
      return String(n);
    }

    function tick(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(target * eased);

      el.textContent = prefix + formatNumber(current) + suffix;

      if (progress < 1) {
        requestAnimationFrame(tick);
      }
    }

    requestAnimationFrame(tick);
  }

  const counterObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          // Small delay to sync with reveal animation
          setTimeout(() => animateCounter(entry.target), 300);
          counterObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.3 }
  );

  counterElements.forEach((el) => counterObserver.observe(el));

  /* ── Smooth Anchor Scrolling ───────────── */
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (e) => {
      const target = document.querySelector(anchor.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  /* ── Nav background on scroll ──────────── */
  const nav = document.querySelector('.ln-nav');
  let lastScroll = 0;

  window.addEventListener('scroll', () => {
    const scrollY = window.scrollY;
    if (scrollY > 100) {
      nav.style.borderBottomColor = 'rgba(255,255,255,.08)';
    } else {
      nav.style.borderBottomColor = '';
    }
    lastScroll = scrollY;
  }, { passive: true });

})();
