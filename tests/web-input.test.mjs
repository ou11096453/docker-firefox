import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { attachDesktopInput } from "../rootfs/opt/noVNC/app/firefox-input.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture() {
    globalThis.window = new EventTarget();
    globalThis.document = new EventTarget();
    document.hidden = false;
    const rfb = new EventTarget();
    const canvas = new EventTarget();
    canvas.style = { flexShrink: "" };
    let left = 0;
    let top = 0;
    const screen = {
        width: 400, height: 600,
        getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; },
        get scrollLeft() { return left; },
        set scrollLeft(value) { left = Math.max(0, Math.min(value, 1280 * rfb._display.scale - this.width)); },
        get scrollTop() { return top; },
        set scrollTop(value) { top = Math.max(0, Math.min(value, 720 * rfb._display.scale - this.height)); },
    };
    canvas.getBoundingClientRect = () => ({
        left: Math.max(0, (screen.width - 1280 * rfb._display.scale) / 2) - left,
        top: Math.max(0, (screen.height - 720 * rfb._display.scale) / 2) - top,
    });
    rfb._canvas = canvas;
    rfb._screen = screen;
    rfb._display = { scale: 0.3125 };
    rfb.scaleViewport = true;
    rfb._updateScale = () => {
        rfb._display.scale = rfb.scaleViewport ? Math.min(screen.width / 1280, screen.height / 720) : 1;
    };
    rfb._fixScrollbars = () => {};
    rfb._saveExpectedClientSize = () => {};
    rfb._mousePos = { x: 20, y: 30 };
    rfb._mouseButtonMask = 0;
    rfb.gestureDetaches = 0;
    rfb.gestureAttaches = 0;
    rfb._gestures = new class Gestures {
        constructor() { this._tracked = []; this._ignored = []; }
        detach() { rfb.gestureDetaches++; }
        attach() { rfb.gestureAttaches++; }
    };
    rfb.releases = [];
    rfb._handleMouseButton = (x, y, mask) => {
        rfb._mouseButtonMask = mask;
        rfb.releases.push({ x, y, mask });
    };
    return rfb;
}

function gesture(canvas, phase, type, magnitudeX = 100, magnitudeY = 0) {
    const event = new Event(`gesture${phase}`);
    event.detail = { type, magnitudeX, magnitudeY, clientX: 200, clientY: 300 };
    canvas.dispatchEvent(event);
}

test("zoom changes noVNC's display scale, clamps to fit through 5x and rejects invalid input", () => {
    const rfb = fixture();
    const input = attachDesktopInput(rfb);
    input.setZoom(2);
    assert.equal(rfb._display.scale, 0.625);
    assert.equal(rfb._canvas.style.flexShrink, "0");
    input.setZoom(100);
    assert.equal(input.zoom, 5);
    input.setZoom(NaN);
    assert.equal(input.zoom, 5);
    input.setZoom(0);
    assert.equal(input.zoom, 1);
    assert.equal(rfb._display.scale, 0.3125);
});

test("pinch zooms the desktop without forwarding Ctrl+wheel gestures", () => {
    const rfb = fixture();
    const input = attachDesktopInput(rfb);
    let forwarded = 0;
    for (const phase of ["start", "move", "end"]) {
        rfb._canvas.addEventListener(`gesture${phase}`, () => forwarded++);
    }
    gesture(rfb._canvas, "start", "pinch", 100);
    gesture(rfb._canvas, "move", "pinch", 200);
    assert.equal(input.zoom, 2);
    gesture(rfb._canvas, "move", "pinch", 100);
    assert.equal(input.zoom, 1);
    gesture(rfb._canvas, "end", "pinch", 100);
    assert.equal(forwarded, 0);
});

test("zoom preserves the desktop point beneath the gesture center", () => {
    const rfb = fixture();
    const input = attachDesktopInput(rfb);
    function point() {
        const bounds = rfb._canvas.getBoundingClientRect();
        return [(200 - bounds.left) / rfb._display.scale, (300 - bounds.top) / rfb._display.scale];
    }
    const before = point();
    input.setZoom(3, { clientX: 200, clientY: 300 });
    assert.deepEqual(point(), before);
});

test("two-finger dragging pans only when the desktop is enlarged", () => {
    const rfb = fixture();
    const input = attachDesktopInput(rfb);
    let forwarded = 0;
    rfb._canvas.addEventListener("gesturemove", () => forwarded++);
    gesture(rfb._canvas, "move", "twodrag", 20, 10);
    assert.equal(forwarded, 1);
    input.setZoom(3);
    const start = rfb._screen.scrollLeft;
    gesture(rfb._canvas, "start", "twodrag", 0, 0);
    gesture(rfb._canvas, "move", "twodrag", -50, -10);
    assert.equal(rfb._screen.scrollLeft, start + 50);
    assert.equal(forwarded, 1);
});

test("single tap, double-tap and right-click gestures retain upstream handling", () => {
    const rfb = fixture();
    attachDesktopInput(rfb);
    const forwarded = [];
    rfb._canvas.addEventListener("gesturestart", event => forwarded.push(event.detail.type));
    for (const type of ["onetap", "onetap", "twotap", "longpress", "drag"]) {
        gesture(rfb._canvas, "start", type);
    }
    assert.deepEqual(forwarded, ["onetap", "onetap", "twotap", "longpress", "drag"]);
});

test("zoom switches a cached remote-resizing session into local scaling", () => {
    const rfb = fixture();
    rfb.scaleViewport = false;
    rfb.resizeSession = true;
    rfb.clipViewport = true;
    let activated = 0;
    const input = attachDesktopInput(rfb, () => activated++);
    gesture(rfb._canvas, "start", "pinch", 100);
    gesture(rfb._canvas, "move", "pinch", 200);
    gesture(rfb._canvas, "move", "pinch", 300);
    assert.equal(input.zoom, 3);
    assert.equal(activated, 1);
    assert.equal(rfb.resizeSession, false);
    assert.equal(rfb.clipViewport, false);
});

test("orientation and desktop resizes keep the selected zoom multiplier", () => {
    const rfb = fixture();
    const input = attachDesktopInput(rfb);
    input.setZoom(2);
    rfb._screen.width = 800;
    rfb._screen.height = 400;
    rfb._updateScale();
    assert.equal(rfb._display.scale, 400 / 720 * 2);
});

test("losing focus or visibility releases a held mouse button and resets touch tracking", () => {
    const rfb = fixture();
    attachDesktopInput(rfb);
    rfb._mouseButtonMask = 1;
    rfb._viewportDragging = true;
    window.dispatchEvent(new Event("blur"));
    assert.deepEqual(rfb.releases, [{ x: 20, y: 30, mask: 0 }]);
    assert.equal(rfb._viewportDragging, false);
    assert.equal(rfb.gestureDetaches, 1);
    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(rfb.gestureDetaches, 2);
});

test("touch cancellation never becomes an accidental upstream tap", () => {
    const rfb = fixture();
    attachDesktopInput(rfb);
    let forwarded = 0;
    rfb._gestures._tracked.push({ id: 1, active: true });
    rfb._canvas.addEventListener("touchcancel", () => forwarded++);
    const event = new Event("touchcancel", { cancelable: true });
    event.touches = [];
    rfb._canvas.dispatchEvent(event);
    assert.equal(forwarded, 0);
    assert.equal(event.defaultPrevented, true);
    assert.equal(rfb.gestureDetaches, 1);
    assert.deepEqual(rfb._gestures._tracked, []);
});

test("focus loss ignores still-pressed fingers until their release instead of interpreting a new tap", () => {
    const rfb = fixture();
    attachDesktopInput(rfb);
    rfb._gestures._tracked.push({ id: 8, active: true });
    window.dispatchEvent(new Event("blur"));
    assert.deepEqual(rfb._gestures._tracked, []);
    assert.deepEqual(rfb._gestures._ignored, [8]);
    assert.equal(rfb._gestures._state, 0);
});

test("touch-generated compatibility mouse events are suppressed without blocking a real mouse", () => {
    const rfb = fixture();
    attachDesktopInput(rfb);
    let forwarded = 0;
    rfb._canvas.addEventListener("mousedown", () => forwarded++);
    const synthetic = new Event("mousedown", { cancelable: true });
    synthetic.sourceCapabilities = { firesTouchEvents: true };
    rfb._canvas.dispatchEvent(synthetic);
    rfb._canvas.dispatchEvent(new Event("mousedown"));
    assert.equal(forwarded, 1);
});

test("disconnect removes handlers, restores upstream scaling and permits a fresh attachment", () => {
    const rfb = fixture();
    const original = rfb._updateScale;
    const input = attachDesktopInput(rfb);
    assert.equal(attachDesktopInput(rfb), input);
    rfb.dispatchEvent(new Event("disconnect"));
    assert.equal(rfb._updateScale, original);
    assert.equal(rfb._canvas.style.flexShrink, "");
    window.dispatchEvent(new Event("blur"));
    assert.equal(rfb.gestureDetaches, 0);
    assert.notEqual(attachDesktopInput(rfb), input);
});

const tools = path.join(root, "rootfs/usr/share/firefox-tools");
const bootstrap = `<!DOCTYPE html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<script type="module">
import UI from "./app/ui.js?v=UNIQUE_VERSION";
        UI.start();
</script>
</head>
`;

function webFixture(index = bootstrap) {
    const temp = process.env.FIREFOX_TEST_TMPDIR || path.join(root, "temp/tests");
    mkdirSync(temp, { recursive: true });
    const directory = mkdtempSync(path.join(temp, "web-"));
    mkdirSync(path.join(directory, "app/styles"), { recursive: true });
    mkdirSync(path.join(directory, "core"), { recursive: true });
    writeFileSync(path.join(directory, "app/firefox-input.js"), "// fixture\n");
    writeFileSync(path.join(directory, "app/styles/firefox-input.css"), "/* fixture */\n");
    writeFileSync(path.join(directory, "core/rfb.js"), "_updateScale() {}\n");
    writeFileSync(path.join(directory, "core/display.js"), "get scale() {}\n");
    writeFileSync(path.join(directory, "index.html"), index);
    return directory;
}

function install(directory) {
    const result = spawnSync(process.env.FIREFOX_TEST_SHELL || "/bin/sh", [
        path.join(tools, "install-web-input.sh").replaceAll("\\", "/"),
        directory.replaceAll("\\", "/"),
    ], {
        encoding: "utf8",
        env: { ...process.env, FIREFOX_TOOLS_DIR: tools.replaceAll("\\", "/") },
    });
    if (result.error) throw result.error;
    return result;
}

test("image installation adds the source module before startup and enables viewport zoom", () => {
    const directory = webFixture();
    const result = install(directory);
    assert.equal(result.status, 0, result.stderr);
    const index = readFileSync(path.join(directory, "index.html"), "utf8");
    assert.ok(index.indexOf("installFirefoxInput(UI)") < index.indexOf("UI.start()"));
    assert.match(index, /user-scalable=yes/);
    assert.match(index, /maximum-scale=5[.]0/);
    assert.match(index, /firefox-input[.]css/);
    assert.equal(install(directory).status, 0);
    assert.equal(readFileSync(path.join(directory, "index.html"), "utf8"), index);
});

test("an incompatible upstream bootstrap fails without changing the original HTML", () => {
    const original = "<head></head>\n";
    const directory = webFixture(original);
    const result = install(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported noVNC bootstrap/);
    assert.equal(readFileSync(path.join(directory, "index.html"), "utf8"), original);
    assert.ok(!readdirSync(directory).some(name => name.startsWith(".index.")));
});

test("both Docker build paths require successful web-input installation", () => {
    for (const file of ["Dockerfile", "Dockerfile.hanging"]) {
        const contents = readFileSync(path.join(root, file), "utf8");
        assert.match(contents, /\/usr\/share\/firefox-tools\/install-web-input[.]sh && \\/);
    }
    const workflow = readFileSync(path.join(root, ".github/workflows/build-image.yml"), "utf8");
    assert.match(workflow, /node --test tests\/\*[.]test[.]mjs/);
    assert.ok(workflow.includes('grep -q "installFirefoxInput(UI)" /opt/noVNC/index.html'));
});
