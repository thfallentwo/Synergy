const PALETTE = [
  { color: '#ffffff', label: 'Beyaz' },
  { color: '#151922', label: 'Kömür' },
  { color: '#67b8ff', label: 'Safir' },
  { color: '#34d399', label: 'Zümrüt' },
  { color: '#fbbf24', label: 'Kehribar' },
  { color: '#f87171', label: 'Mercan' },
];

const DARK_BG = '#0b0f17';
const LIGHT_BG = '#f8fafc';

export function mountCanvas(container, onSendImage) {
  if (!container) return () => {};

  const isLightTheme = document.documentElement.getAttribute('data-theme') === 'light';
  let bgDark = !isLightTheme;
  let brushColor = bgDark ? '#ffffff' : '#151922';
  let brushSize = 4;
  let erasing = false;
  let drawing = false;
  let activeSource = null;
  let lastPt = null;

  container.innerHTML = `
    <div class="canvas-studio">
      <div class="canvas-toolbar">
        <div class="canvas-group canvas-colors" role="group" aria-label="Fırça renkleri">
          ${PALETTE.map(
            (p) =>
              `<button type="button" class="canvas-swatch${p.color === brushColor ? ' active' : ''}" data-color="${p.color}" title="${p.label}" style="background:${p.color}"></button>`,
          ).join('')}
        </div>

        <label class="canvas-group canvas-size-wrap" title="Fırça kalınlığı">
          <span>Kalınlık</span>
          <input type="range" class="canvas-size" min="2" max="24" value="${brushSize}" />
          <span class="canvas-size-val">${brushSize}px</span>
        </label>

        <div class="canvas-group canvas-actions">
          <button type="button" class="btn canvas-eraser" aria-pressed="false">Silgi</button>
          <button type="button" class="btn canvas-bg-toggle">${bgDark ? 'Zemin: Koyu' : 'Zemin: Açık'}</button>
          <button type="button" class="btn canvas-clear">Temizle</button>
          <button type="button" class="btn btn-primary canvas-send">Sohbete Gönder</button>
        </div>
      </div>

      <div class="canvas-stage">
        <canvas class="canvas-surface" width="960" height="540"></canvas>
      </div>
    </div>
  `;

  const canvas = container.querySelector('.canvas-surface');
  const ctx = canvas.getContext('2d');
  const sizeInput = container.querySelector('.canvas-size');
  const sizeVal = container.querySelector('.canvas-size-val');
  const eraserBtn = container.querySelector('.canvas-eraser');
  const bgBtn = container.querySelector('.canvas-bg-toggle');
  const clearBtn = container.querySelector('.canvas-clear');
  const sendBtn = container.querySelector('.canvas-send');
  const swatches = container.querySelectorAll('.canvas-swatch');

  const bgColor = () => (bgDark ? DARK_BG : LIGHT_BG);

  const fillBackground = () => {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = bgColor();
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  };

  fillBackground();

  const pointFromEvent = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width ? canvas.width / rect.width : 1;
    const scaleY = rect.height ? canvas.height / rect.height : 1;
    return {
      x: (ev.clientX - rect.left) * scaleX,
      y: (ev.clientY - rect.top) * scaleY,
    };
  };

  const activeStrokeColor = () => (erasing ? bgColor() : brushColor);
  const activeStrokeWidth = () => (erasing ? Math.max(brushSize * 2, 10) : brushSize);

  const startStroke = (pt) => {
    drawing = true;
    lastPt = pt;
    ctx.fillStyle = activeStrokeColor();
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, activeStrokeWidth() / 2, 0, Math.PI * 2);
    ctx.fill();
  };

  const moveStroke = (pt) => {
    if (!drawing || !lastPt) return;
    ctx.strokeStyle = activeStrokeColor();
    ctx.lineWidth = activeStrokeWidth();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(lastPt.x, lastPt.y);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    lastPt = pt;
  };

  const endStroke = () => {
    drawing = false;
    lastPt = null;
    activeSource = null;
  };

  const onPointerDown = (ev) => {
    if (ev.button !== undefined && ev.button !== 0 && ev.pointerType === 'mouse') return;
    activeSource = 'pointer';
    canvas.setPointerCapture?.(ev.pointerId);
    startStroke(pointFromEvent(ev));
  };

  const onPointerMove = (ev) => {
    if (activeSource !== 'pointer' || !drawing) return;
    moveStroke(pointFromEvent(ev));
  };

  const onPointerUp = (ev) => {
    if (activeSource !== 'pointer') return;
    canvas.releasePointerCapture?.(ev.pointerId);
    endStroke();
  };

  const onMouseDown = (ev) => {
    if (activeSource === 'pointer' || ev.button !== 0) return;
    activeSource = 'mouse';
    startStroke(pointFromEvent(ev));
  };

  const onMouseMove = (ev) => {
    if (activeSource !== 'mouse' || !drawing) return;
    moveStroke(pointFromEvent(ev));
  };

  const onMouseUp = () => {
    if (activeSource !== 'mouse') return;
    endStroke();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  swatches.forEach((btn) => {
    btn.addEventListener('click', () => {
      brushColor = btn.dataset.color || '#ffffff';
      erasing = false;
      eraserBtn.classList.remove('active');
      eraserBtn.setAttribute('aria-pressed', 'false');
      swatches.forEach((s) => s.classList.toggle('active', s === btn));
    });
  });

  sizeInput?.addEventListener('input', () => {
    brushSize = Math.min(24, Math.max(2, Number(sizeInput.value) || 4));
    if (sizeVal) sizeVal.textContent = `${brushSize}px`;
  });

  eraserBtn?.addEventListener('click', () => {
    erasing = !erasing;
    eraserBtn.classList.toggle('active', erasing);
    eraserBtn.setAttribute('aria-pressed', erasing ? 'true' : 'false');
  });

  bgBtn?.addEventListener('click', () => {
    bgDark = !bgDark;
    bgBtn.textContent = bgDark ? 'Zemin: Koyu' : 'Zemin: Açık';
    fillBackground();
  });

  clearBtn?.addEventListener('click', () => {
    fillBackground();
  });

  sendBtn?.addEventListener('click', () => {
    onSendImage?.(canvas.toDataURL('image/png'));
  });

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };
}
