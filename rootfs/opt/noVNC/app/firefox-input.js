const MAX_ZOOM = 5;
const connections = new WeakMap();

export function attachDesktopInput(rfb, activateScaling = () => {}, onChange = () => {}) {
    if (connections.has(rfb)) return connections.get(rfb);

    const canvas = rfb._canvas;
    const screen = rfb._screen;
    const originalUpdateScale = rfb._updateScale;
    const originalFlexShrink = canvas.style.flexShrink;
    const listeners = [];
    let zoom = 1;
    let pinch = null;
    let pan = null;
    let disposed = false;

    // CSS shrinking must not disagree with Display.scale's pointer coordinates.
    canvas.style.flexShrink = "0";
    rfb._updateScale = function () {
        originalUpdateScale.call(this);
        if (this.scaleViewport && zoom !== 1) {
            this._display.scale *= zoom;
            this._fixScrollbars();
        }
    };

    function listen(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        listeners.push(() => target.removeEventListener(type, handler, options));
    }

    function releaseButtons() {
        if (rfb._mouseButtonMask) {
            rfb._handleMouseButton(rfb._mousePos.x || 0, rfb._mousePos.y || 0, 0);
        }
        rfb._viewportDragging = false;
        pinch = null;
        pan = null;
    }

    function cancelTouches(event) {
        const gestures = rfb._gestures;
        const remaining = event && "touches" in event
            ? Array.from(event.touches, touch => touch.identifier)
            : [...gestures._ignored, ...gestures._tracked.filter(touch => touch.active).map(touch => touch.id)];
        gestures.detach();
        if (!disposed) {
            // detach() stops timers but retains touches in noVNC 1.7.
            rfb._gestures = new gestures.constructor();
            // Ignore releases from fingers that were still down when focus was lost.
            rfb._gestures._ignored = remaining;
            if (remaining.length) rfb._gestures._state = 0;
            rfb._gestures.attach(canvas);
        }
        releaseButtons();
    }

    function setZoom(value, anchor) {
        if (disposed || !Number.isFinite(value)) return;
        const nextZoom = Math.min(MAX_ZOOM, Math.max(1, value));
        if (!rfb.scaleViewport) {
            activateScaling();
            rfb.resizeSession = false;
            rfb.clipViewport = false;
            rfb.scaleViewport = true;
        }
        const bounds = canvas.getBoundingClientRect();
        const center = screen.getBoundingClientRect();
        const point = anchor || {
            clientX: center.left + center.width / 2,
            clientY: center.top + center.height / 2,
        };
        const scale = rfb._display.scale;
        const x = scale > 0 ? (point.clientX - bounds.left) / scale : 0;
        const y = scale > 0 ? (point.clientY - bounds.top) / scale : 0;
        zoom = nextZoom;
        rfb._updateScale();
        const nextBounds = canvas.getBoundingClientRect();
        screen.scrollLeft += nextBounds.left + x * rfb._display.scale - point.clientX;
        screen.scrollTop += nextBounds.top + y * rfb._display.scale - point.clientY;
        rfb._saveExpectedClientSize();
        onChange(zoom);
    }

    function handleGesture(event) {
        const detail = event.detail;
        const isPinch = detail.type === "pinch";
        const isPan = detail.type === "twodrag" && zoom > 1;
        if (!isPinch && !isPan) return;

        // Do not send Ctrl+wheel or a remote drag when manipulating the viewer.
        event.stopImmediatePropagation();
        if (isPinch) {
            const distance = Math.hypot(detail.magnitudeX, detail.magnitudeY);
            if (event.type === "gesturestart") {
                releaseButtons();
                pinch = { distance, zoom };
            } else if (event.type === "gesturemove" && pinch && pinch.distance > 0) {
                setZoom(pinch.zoom * distance / pinch.distance, detail);
            } else if (event.type === "gestureend") {
                pinch = null;
            }
        } else if (event.type === "gesturestart") {
            releaseButtons();
            pan = { x: detail.magnitudeX, y: detail.magnitudeY };
        } else if (event.type === "gesturemove" && pan) {
            screen.scrollLeft -= detail.magnitudeX - pan.x;
            screen.scrollTop -= detail.magnitudeY - pan.y;
            pan = { x: detail.magnitudeX, y: detail.magnitudeY };
        } else if (event.type === "gestureend") {
            pan = null;
        }
    }

    for (const type of ["gesturestart", "gesturemove", "gestureend"]) {
        listen(canvas, type, handleGesture, true);
    }
    listen(canvas, "touchcancel", event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelTouches(event);
    }, { capture: true, passive: false });
    for (const type of ["mousedown", "mouseup", "mousemove"]) {
        listen(canvas, type, event => {
            if (event.sourceCapabilities?.firesTouchEvents) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        }, true);
    }
    listen(canvas, "pointercancel", releaseButtons);
    listen(window, "blur", cancelTouches);
    listen(document, "visibilitychange", () => {
        if (document.hidden) cancelTouches();
    });
    listen(rfb, "disconnect", dispose);

    function reset() {
        if (disposed) return;
        releaseButtons();
        zoom = 1;
        rfb._updateScale();
        screen.scrollLeft = 0;
        screen.scrollTop = 0;
        onChange(zoom);
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        listeners.forEach(remove => remove());
        releaseButtons();
        rfb._updateScale = originalUpdateScale;
        canvas.style.flexShrink = originalFlexShrink;
        connections.delete(rfb);
        onChange(null);
    }

    const controller = { setZoom, reset, dispose, get zoom() { return zoom; } };
    connections.set(rfb, controller);
    return controller;
}

export default function installFirefoxInput(UI) {
    let controller = null;
    const section = document.createElement("li");
    section.className = "list-group-item";
    section.id = "noVNC_zoom_section";
    section.innerHTML = `
        <div class="firefox-zoom-controls">
            <button type="button" class="btn shadow-none" id="noVNC_zoom_out"
                    title="Zoom out" aria-label="Zoom out" disabled>
                <i class="fas fa-search-minus fa-fw" aria-hidden="true"></i>
            </button>
            <button type="button" class="btn shadow-none" id="noVNC_zoom_fit"
                    title="Fit desktop" aria-label="Fit desktop" disabled>
                <i class="fas fa-compress-arrows-alt fa-fw" aria-hidden="true"></i>
            </button>
            <output id="noVNC_zoom_value" aria-label="Desktop zoom">100%</output>
            <button type="button" class="btn shadow-none" id="noVNC_zoom_in"
                    title="Zoom in" aria-label="Zoom in" disabled>
                <i class="fas fa-search-plus fa-fw" aria-hidden="true"></i>
            </button>
        </div>`;
    document.getElementById("noVNC_action_icons_section").after(section);
    const out = document.getElementById("noVNC_zoom_out");
    const fit = document.getElementById("noVNC_zoom_fit");
    const into = document.getElementById("noVNC_zoom_in");
    const value = document.getElementById("noVNC_zoom_value");

    function update(zoom) {
        const connected = zoom !== null && UI.connected;
        out.disabled = !connected || zoom <= 1;
        fit.disabled = !connected;
        into.disabled = !connected || zoom >= MAX_ZOOM;
        value.value = `${Math.round((zoom || 1) * 100)}%`;
    }

    out.addEventListener("click", () => controller?.setZoom(controller.zoom / 1.25));
    into.addEventListener("click", () => controller?.setZoom(controller.zoom * 1.25));
    fit.addEventListener("click", () => controller?.setZoom(1));

    const originalConnect = UI.connect;
    UI.connect = function (...args) {
        const result = originalConnect.apply(this, args);
        if (UI.rfb) {
            controller = attachDesktopInput(UI.rfb, () => {
                UI.forceSetting("resize", "scale");
                originalApplyResizeMode.call(UI);
                UI.updateViewClip();
            }, update);
            UI.rfb.addEventListener("connect", () => update(controller.zoom), { once: true });
        }
        return result;
    };
    const originalApplyResizeMode = UI.applyResizeMode;
    UI.applyResizeMode = function (...args) {
        controller?.reset();
        return originalApplyResizeMode.apply(this, args);
    };
}
