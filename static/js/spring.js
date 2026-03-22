/* ════════════════════════════════════════════════
   Spring Animation Engine
   Ported from Remotion's spring physics model
════════════════════════════════════════════════ */

const Spring = (() => {

  // Track active animations per element so we can cancel previous ones
  const _activeAnimations = new Map();

  // Damped harmonic oscillator simulation
  // Returns array of values from 0→1 (with possible overshoot)
  function simulate({ mass = 1, damping = 10, stiffness = 100, fps = 60 } = {}) {
    const steps = [];
    let pos = 0, vel = 0;
    const dt = 1 / fps;
    const threshold = 0.001;
    for (let i = 0; i < 600; i++) { // max 10s at 60fps
      const springForce = -stiffness * (pos - 1);
      const dampForce = -damping * vel;
      const acc = (springForce + dampForce) / mass;
      vel += acc * dt;
      pos += vel * dt;
      steps.push(pos);
      if (i > 0 && Math.abs(pos - 1) < threshold && Math.abs(vel) < threshold) break;
    }
    return steps;
  }

  // Presets matching Remotion conventions
  const presets = {
    smooth: { damping: 200, stiffness: 100, mass: 1 },
    snappy: { damping: 20, stiffness: 200, mass: 1 },
    bouncy: { damping: 8, stiffness: 100, mass: 1 },
    heavy:  { damping: 15, stiffness: 80, mass: 2 },
  };

  // Interpolate a value from one range to another
  function interpolate(value, inMin, inMax, outMin, outMax) {
    const t = Math.max(0, Math.min(1, (value - inMin) / (inMax - inMin)));
    return outMin + t * (outMax - outMin);
  }

  // Cancel any running animation on an element
  function cancelElement(el) {
    if (!el) return;
    const existing = _activeAnimations.get(el);
    if (existing) {
      existing.cancelled = true;
      cancelAnimationFrame(existing.rafId);
      _activeAnimations.delete(el);
    }
  }

  // Core animate function — drives a spring and calls onUpdate each frame
  // Returns a promise that resolves when the spring settles
  // onUpdate receives progress (0→1, may overshoot) and raw frame index
  function animate(el, {
    preset = 'snappy',
    config,
    delay = 0,
    onUpdate,
    onComplete,
  } = {}) {
    // Cancel any previous animation on this element
    if (el) cancelElement(el);

    const cfg = config || presets[preset] || presets.snappy;
    const steps = simulate(cfg);
    let frame = 0;
    let settled = false;

    const handle = { cancelled: false, rafId: 0 };
    if (el) _activeAnimations.set(el, handle);

    return new Promise(resolve => {
      function tick() {
        if (handle.cancelled) { resolve(); return; }
        if (frame < delay) {
          frame++;
          handle.rafId = requestAnimationFrame(tick);
          return;
        }
        const i = frame - delay;
        if (i >= steps.length) {
          if (!settled) {
            settled = true;
            if (onUpdate) onUpdate(1, i);
            if (onComplete) onComplete();
          }
          if (el) _activeAnimations.delete(el);
          resolve();
          return;
        }
        if (onUpdate) onUpdate(steps[i], i);
        frame++;
        handle.rafId = requestAnimationFrame(tick);
      }
      handle.rafId = requestAnimationFrame(tick);
    });
  }

  // Stagger helper — runs animate() on multiple elements with incremental delays
  function stagger(elements, { staggerFrames = 4, ...opts } = {}) {
    return Array.from(elements).map((el, i) =>
      animate(el, { ...opts, delay: (opts.delay || 0) + i * staggerFrames })
    );
  }

  // Shortcut: spring-driven transform animation
  function springTo(el, {
    from = {},
    to = {},
    preset = 'snappy',
    config,
    delay = 0,
  } = {}) {
    const props = Object.keys(to);
    return animate(el, {
      preset,
      config,
      delay,
      onUpdate(progress) {
        const transforms = [];
        const styles = {};
        props.forEach(prop => {
          const start = from[prop] ?? 0;
          const end = to[prop] ?? 0;
          const val = start + (end - start) * progress;
          if (['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate'].includes(prop)) {
            if (prop === 'x') transforms.push(`translateX(${val}px)`);
            else if (prop === 'y') transforms.push(`translateY(${val}px)`);
            else if (prop === 'rotate') transforms.push(`rotate(${val}deg)`);
            else if (prop === 'scale') transforms.push(`scale(${val})`);
            else if (prop === 'scaleX') transforms.push(`scaleX(${val})`);
            else if (prop === 'scaleY') transforms.push(`scaleY(${val})`);
          } else if (prop === 'opacity') {
            // Clamp opacity to valid range
            styles.opacity = Math.max(0, Math.min(1, val));
          } else {
            styles[prop] = val;
          }
        });
        if (transforms.length) el.style.transform = transforms.join(' ');
        Object.entries(styles).forEach(([k, v]) => { el.style[k] = v; });
      },
      onComplete() {
        // Snap to final values
        const transforms = [];
        props.forEach(prop => {
          const end = to[prop] ?? 0;
          if (prop === 'x') transforms.push(`translateX(${end}px)`);
          else if (prop === 'y') transforms.push(`translateY(${end}px)`);
          else if (prop === 'rotate') transforms.push(`rotate(${end}deg)`);
          else if (prop === 'scale') transforms.push(`scale(${end})`);
          else if (prop === 'scaleX') transforms.push(`scaleX(${end})`);
          else if (prop === 'scaleY') transforms.push(`scaleY(${end})`);
          else if (prop === 'opacity') el.style.opacity = Math.max(0, Math.min(1, end));
        });
        if (transforms.length) el.style.transform = transforms.join(' ');
      },
    });
  }

  return { simulate, presets, interpolate, animate, stagger, springTo, cancelElement };

})();
