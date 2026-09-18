// =============================================================================
// MAC0623 — Assignment 2 — VR Port and Comparison
//
// One codebase, five runtime-selectable conditions:
//   "1"             — A1 desktop baseline  (click-select, Space/Tab toggle,
//                                            mouse translate/rotate, wheel depth)
//   "2"             — A1 desktop alternate (Space/Tab toggle, WASD/arrow)
//   "vr-grab"       — VR direct grab (6DoF rigid attach)
//   "vr-trackball"  — VR trackball (indirect rotation with gain; direct translation)
//   "vr-gizmo"      — VR gizmo (per-axis handles, raycast pick, constrained drag)
//
// The task, tolerance constants, error computation, and CSV writer are shared
// across every condition — that is the whole point of the A2 comparison.
// =============================================================================

import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";

// ---------------------------------------------------------------------------
// Module-scope state
// ---------------------------------------------------------------------------
let scene, camera, renderer, cube, target, worldHud;

// WebXR controller (target-ray pose).
let vrController = null;

// Per-condition VR state
let trackballRotationState = null;
let trackballTranslationState = null;
let gizmoGroup = null;
let gizmoHoveredHandle = null;
let gizmoDragState = null;

// Desktop mapping state — ported from A1.
// `mapping` is refreshed each frame in updateControlMapping() from the select.
let mapping = "1";
let modeSwitches = 0;      // incremented on each Space/Tab toggle
let selected = null;       // mapping 1: cube is only manipulated after a click

// ---------------------------------------------------------------------------
// Named constants — A1 baseline (unchanged)
// ---------------------------------------------------------------------------
const BACKGROUND_COLOR = 0x1a1a1a;
const HEMISPHERE_SKY_COLOR = 0xffffff;
const HEMISPHERE_GROUND_COLOR = 0x444444;
const DIRECTIONAL_LIGHT_COLOR = 0xffffff;
const GRID_COLOR_CENTER_LINE = 0x444444;
const GRID_COLOR_LINES = 0x2a2a2a;

const CUBE_FACE_COLORS = [0x3f7fd6, 0x2c5aa0, 0xe0c341, 0xa08a2c, 0xff5c5c, 0x7a2f2f];

const HEMISPHERE_LIGHT_INTENSITY = 1.2;
const DIRECTIONAL_LIGHT_INTENSITY = 0.8;
const DIRECTIONAL_LIGHT_POSITION = [2, 4, 3];

const GRID_SIZE = 6;
const GRID_DIVISIONS = 24;
const AXES_HELPER_SIZE = 0.6;

const CUBE_SIZE = 0.4;
const CUBE_INITIAL_POSITION = [0, 0.5, 0];
const TARGET_OPACITY = 0.35;

const CAMERA_FOV_DEG = 60;
const CAMERA_NEAR = 0.05;
const CAMERA_FAR = 100;
const CAMERA_POSITION = [0, 1.4, 4];
const CAMERA_LOOK_AT = [0, 0.5, 0];

// Desktop mapping speeds — carried over from the A1 implementation.
const MAP1_MOUSE_SCALE = 0.01;
const MAP1_WHEEL_ROT_SCALE_Z = 0.001;
const MAP1_WHEEL_TRANS_SCALE_Z = 0.002;
const MAP2_KEY_STEP = 0.05;
const MAP2_KEY_ROT = 0.1;

const RAY_LENGTH_SCALE = 1.5;
const RAY_COLOR = 0xffffff;

const WORLD_HUD_CANVAS_WIDTH = 512;
const WORLD_HUD_CANVAS_HEIGHT = 160;
const WORLD_HUD_SPRITE_SCALE = [0.22, 0.069, 1];
const WORLD_HUD_LOCAL_POSITION = [0.46, 0.32, -0.7];
const AXIS_SWATCH_X = "#" + CUBE_FACE_COLORS[0].toString(16).padStart(6, "0");
const AXIS_SWATCH_Y = "#" + CUBE_FACE_COLORS[2].toString(16).padStart(6, "0");
const AXIS_SWATCH_Z = "#" + CUBE_FACE_COLORS[4].toString(16).padStart(6, "0");

// ---------------------------------------------------------------------------
// Named constants — A2 VR additions
// ---------------------------------------------------------------------------

// ---- VR trackball gain ---------------------------------------------------
//
// On the desktop baseline rotation runs at ROTATE_SPEED = 0.005 rad/px, so a
// 180° reorientation costs ~628 px of mouse travel. A wrist cannot sustain
// that range — it twists roughly ±90° before it hits joint limits, and unlike
// a mouse there is no "lift and re-centre" gesture available mid-air.
//
// TRACKBALL_ROTATION_GAIN = 2.0 means a comfortable ±90° wrist twist maps to
// a ±180° cube reorientation — one motion covers the full orientation range
// the task generates. It is also small enough that hand tremor of ~1° at the
// controller becomes ~2° at the cube, well inside the shared 10° angular
// tolerance. Gain 1.0 would be indistinguishable from the vr-grab condition,
// so 2.0 is the smallest multiplier that makes the technique measurably
// different from a rigid attach.
const TRACKBALL_ROTATION_GAIN = 2.0;

// ---- VR gizmo geometry ---------------------------------------------------
// Handles are WORLD-aligned (see buildGizmo). The cube's orientation is what
// the task asks the user to change, so if handles were cube-local the axes
// would move under the user during a rotation, which breaks the mental model.
// World-aligned handles give a stable reference frame — the same reasoning
// that led the desktop translator to run in the camera's screen frame.
const GIZMO_ARROW_LENGTH   = 0.30;
const GIZMO_ARROW_SHAFT_R  = 0.012;
const GIZMO_ARROW_HEAD_R   = 0.035;
const GIZMO_ARROW_HEAD_L   = 0.08;
const GIZMO_RING_RADIUS    = 0.30;
const GIZMO_RING_TUBE      = 0.015;
const GIZMO_BASE_OPACITY   = 0.55;
const GIZMO_HOVER_OPACITY  = 1.0;
const GIZMO_COLOR_X        = 0xff4444;
const GIZMO_COLOR_Y        = 0x44dd44;
const GIZMO_COLOR_Z        = 0x4488ff;

// ---------------------------------------------------------------------------
// buildScene()
// ---------------------------------------------------------------------------
function buildScene() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKGROUND_COLOR);

    scene.add(new THREE.HemisphereLight(HEMISPHERE_SKY_COLOR, HEMISPHERE_GROUND_COLOR, HEMISPHERE_LIGHT_INTENSITY));
    const dirLight = new THREE.DirectionalLight(DIRECTIONAL_LIGHT_COLOR, DIRECTIONAL_LIGHT_INTENSITY);
    dirLight.position.set(...DIRECTIONAL_LIGHT_POSITION);
    scene.add(dirLight);

    scene.add(new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS, GRID_COLOR_CENTER_LINE, GRID_COLOR_LINES));
    scene.add(new THREE.AxesHelper(AXES_HELPER_SIZE));

    const cubeGeometry = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);

    const cube = new THREE.Mesh(
        cubeGeometry,
        CUBE_FACE_COLORS.map((color) => new THREE.MeshStandardMaterial({ color }))
    );
    cube.position.set(...CUBE_INITIAL_POSITION);
    scene.add(cube);

    const target = new THREE.Mesh(
        cubeGeometry.clone(),
        CUBE_FACE_COLORS.map((color) => new THREE.MeshStandardMaterial({
            color,
            transparent: true,
            opacity: TARGET_OPACITY,
            depthWrite: false,
        }))
    );
    scene.add(target);

    return { scene, cube, target };
}

// ---------------------------------------------------------------------------
// buildWorldHud()
// ---------------------------------------------------------------------------
function buildWorldHud() {
    const canvas = document.createElement("canvas");
    canvas.width = WORLD_HUD_CANVAS_WIDTH;
    canvas.height = WORLD_HUD_CANVAS_HEIGHT;
    const ctx = canvas.getContext("2d");
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
    }));
    sprite.scale.set(...WORLD_HUD_SPRITE_SCALE);
    sprite.renderOrder = 999;
    sprite.visible = false;
    return { sprite, canvas, ctx, texture };
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------
function main() {
    const built = buildScene();
    scene = built.scene;
    cube = built.cube;
    target = built.target;

    worldHud = buildWorldHud();

    camera = new THREE.PerspectiveCamera(
        CAMERA_FOV_DEG,
        window.innerWidth / window.innerHeight,
        CAMERA_NEAR,
        CAMERA_FAR
    );
    camera.position.set(...CAMERA_POSITION);
    camera.lookAt(...CAMERA_LOOK_AT);

    camera.add(worldHud.sprite);
    worldHud.sprite.position.set(...WORLD_HUD_LOCAL_POSITION);
    scene.add(camera);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    window.addEventListener("resize", handleWindowResize);

    // Gizmo handles live in the scene, hidden until the vr-gizmo condition
    // is selected and an XR session is active.
    gizmoGroup = buildGizmo();
    scene.add(gizmoGroup);

    setupWebXR();

    startTrial();
    animate();
}

function handleWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// ---------------------------------------------------------------------------
// Target pose generation — unchanged from A1
// ---------------------------------------------------------------------------
function randomQuaternionShoemake() {
    const u1 = Math.random();
    const u2 = Math.random();
    const u3 = Math.random();

    const sqrt1MinusU1 = Math.sqrt(1 - u1);
    const sqrtU1 = Math.sqrt(u1);

    const theta1 = 2 * Math.PI * u2;
    const theta2 = 2 * Math.PI * u3;

    return new THREE.Quaternion(
        sqrt1MinusU1 * Math.sin(theta1),
        sqrt1MinusU1 * Math.cos(theta1),
        sqrtU1 * Math.sin(theta2),
        sqrtU1 * Math.cos(theta2)
    );
}

const TARGET_BOUNDS = {
    x: [-1.0, 1.0],
    y: [0.2, 1.6],
    z: [-0.6, 0.6],
};

function randomInRange([min, max]) {
    return min + Math.random() * (max - min);
}

function generateTargetPose() {
    target.position.set(
        randomInRange(TARGET_BOUNDS.x),
        randomInRange(TARGET_BOUNDS.y),
        randomInRange(TARGET_BOUNDS.z)
    );
    target.quaternion.copy(randomQuaternionShoemake());
}

// ---------------------------------------------------------------------------
// Tolerance — shared by every condition, unchanged from A1
// ---------------------------------------------------------------------------
const POSITION_TOLERANCE = 0.05;
const ORIENTATION_TOLERANCE_DEG = 10;

function checkTolerance() {
    const positionError = cube.position.distanceTo(target.position);
    const orientationErrorRad = cube.quaternion.angleTo(target.quaternion);
    const orientationErrorDeg = THREE.MathUtils.radToDeg(orientationErrorRad);

    const withinTolerance =
        positionError <= POSITION_TOLERANCE &&
        orientationErrorDeg <= ORIENTATION_TOLERANCE_DEG;

    return { positionError, orientationErrorDeg, withinTolerance };
}

// ---------------------------------------------------------------------------
// HUD references
// ---------------------------------------------------------------------------
const participantIdInput = document.getElementById("participantId");
const mappingSelect = document.getElementById("mappingSelect");
const trialCountEl = document.getElementById("trialCount");
const confirmBtn = document.getElementById("confirmBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");

// ---------------------------------------------------------------------------
// Trial state machine — CSV fields unchanged from A1
// ---------------------------------------------------------------------------
let trialNumber = 0;

let presentationOrderByMapping = {
    "1": 0,
    "2": 0,
    "vr-grab": 0,
    "vr-trackball": 0,
    "vr-gizmo": 0,
};

let trialStartTime = performance.now();
let pathLength = 0;
let lastCubePosition = new THREE.Vector3();

const rows = [];
const CSV_HEADER = [
    "participant_id",
    "mapping",
    "trial_number",
    "presentation_order",
    "completion_time_s",
    "final_position_error",
    "final_orientation_error_deg",
    "mode_switches",
    "path_length",
];

function currentMapping() {
    mapping = mappingSelect.value;
    return mapping;
}

function startTrial() {
    trialStartTime = performance.now();
    pathLength = 0;
    lastCubePosition.copy(cube.position);
    modeSwitches = 0;
    generateTargetPose();
    trialCountEl.textContent = `Trial ${trialNumber + 1}`;

    // Reset any in-flight VR manipulation state so a fresh trial can't
    // inherit a half-finished grab / trackball gesture / gizmo drag.
    resetVrManipulationState();
}

function confirmTrial() {
    const { positionError, orientationErrorDeg } = checkTolerance();
    const completionTimeS = (performance.now() - trialStartTime) / 1000;
    const mappingValue = currentMapping();

    trialNumber += 1;
    presentationOrderByMapping[mappingValue] =
        (presentationOrderByMapping[mappingValue] || 0) + 1;

    rows.push({
        participant_id: participantIdInput.value.trim() || "UNKNOWN",
        mapping: mappingValue,
        trial_number: trialNumber,
        presentation_order: presentationOrderByMapping[mappingValue],
        completion_time_s: completionTimeS.toFixed(3),
        final_position_error: positionError.toFixed(4),
        final_orientation_error_deg: orientationErrorDeg.toFixed(2),
        mode_switches: modeSwitches,
        path_length: pathLength.toFixed(4),
    });

    startTrial();
}

confirmBtn.addEventListener("click", confirmTrial);
window.addEventListener("keydown", handleKeydown);

function handleKeydown(e) {
    if (e.key === "Enter") confirmTrial();
}

// ---------------------------------------------------------------------------
// CSV download — filename tagged A2
// ---------------------------------------------------------------------------
function buildCsv() {
    const lines = [CSV_HEADER.join(",")];
    for (const row of rows) {
        lines.push(
            CSV_HEADER.map(function (key) {
                return row[key];
            }).join(",")
        );
    }
    return lines.join("\n");
}

downloadBtn.addEventListener("click", handleDownloadClick);

function handleDownloadClick() {
    const csv = buildCsv();
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const pid = participantIdInput.value.trim() || "UNKNOWN";
    a.href = url;
    a.download = `A2_${pid}_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Status indicator + world HUD — unchanged from A1
// ---------------------------------------------------------------------------
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const _axisA = new THREE.Vector3();
const _axisB = new THREE.Vector3();

function axisRotationErrorDeg(axis) {
    _axisA.copy(axis).applyQuaternion(cube.quaternion);
    _axisB.copy(axis).applyQuaternion(target.quaternion);
    return THREE.MathUtils.radToDeg(_axisA.angleTo(_axisB));
}

function updateStatus() {
    const { positionError, orientationErrorDeg, withinTolerance } = checkTolerance();
    const xErr = axisRotationErrorDeg(AXIS_X);
    const yErr = axisRotationErrorDeg(AXIS_Y);
    const zErr = axisRotationErrorDeg(AXIS_Z);
    statusEl.textContent =
        `dPos ${positionError.toFixed(3)} | dRot ${orientationErrorDeg.toFixed(1)}deg ` +
        `(X ${xErr.toFixed(1)} Y ${yErr.toFixed(1)} Z ${zErr.toFixed(1)})`;
    statusEl.classList.toggle("in-tolerance", withinTolerance);
    updateWorldHud(positionError, orientationErrorDeg, xErr, yErr, zErr, withinTolerance);
}

function updateWorldHud(positionError, orientationErrorDeg, xErr, yErr, zErr, withinTolerance) {
    if (!renderer.xr.isPresenting) {
        worldHud.sprite.visible = false;
        return;
    }
    worldHud.sprite.visible = true;

    const { ctx, canvas, texture } = worldHud;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = withinTolerance ? "rgba(30,70,40,0.85)" : "rgba(20,20,26,0.85)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.textBaseline = "top";
    ctx.fillStyle = withinTolerance ? "#9f9" : "#eee";
    ctx.font = "600 34px system-ui, sans-serif";
    ctx.fillText(`dPos ${positionError.toFixed(3)}  dRot ${orientationErrorDeg.toFixed(1)}deg`, 16, 14);

    ctx.font = "600 30px system-ui, sans-serif";
    ctx.fillStyle = AXIS_SWATCH_X;
    ctx.fillText(`X ${xErr.toFixed(1)}`, 16, 76);
    ctx.fillStyle = AXIS_SWATCH_Y;
    ctx.fillText(`Y ${yErr.toFixed(1)}`, 190, 76);
    ctx.fillStyle = AXIS_SWATCH_Z;
    ctx.fillText(`Z ${zErr.toFixed(1)}`, 360, 76);

    texture.needsUpdate = true;
}

// =============================================================================
// Desktop control mappings — ported from A1, unchanged in behaviour
// =============================================================================

// ---- Mapping 1: click-to-select, Space/Tab toggle, mouse, wheel -----------
const raycaster = new THREE.Raycaster();
const ponto = new THREE.Vector2();

window.addEventListener("click", (event) => {
    // Only mapping 1 uses click-to-select; other conditions ignore it.
    if (mapping !== "1") return;
    ponto.x = (event.clientX / window.innerWidth) * 2 - 1;
    ponto.y = -(event.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(ponto, camera);
    const intersects = raycaster.intersectObjects([cube]);
    selected = intersects.length > 0 ? intersects[0].object : null;
});

window.addEventListener("keydown", (e) => {
    // VR conditions don't use keyboard mode toggling.
    if (typeof mapping === "string" && mapping.startsWith("vr-")) return;
    const k = e.key.toLowerCase();

    if (mapping == 1) {
        if (k === " " || k === "tab") {
            e.preventDefault();
            modeSwitches += 1;
        }
        if (k === "escape") {
            selected = null;
        }
    } else if (mapping == 2) {
        if (k === " " || k === "tab") {
            e.preventDefault();
            modeSwitches += 1;
        } else if (modeSwitches % 2 === 1) {
            // Translate mode
            if (k === "w") cube.position.z -= MAP2_KEY_STEP;
            if (k === "a" || k === "arrowleft") cube.position.x -= MAP2_KEY_STEP;
            if (k === "s") cube.position.z += MAP2_KEY_STEP;
            if (k === "d" || k === "arrowright") cube.position.x += MAP2_KEY_STEP;
            if (k === "arrowup") cube.position.y += MAP2_KEY_STEP;
            if (k === "arrowdown") cube.position.y -= MAP2_KEY_STEP;
        } else {
            // Rotate mode
            const eixoX = new THREE.Vector3(1, 0, 0);
            const eixoY = new THREE.Vector3(0, 1, 0);
            const eixoZ = new THREE.Vector3(0, 0, 1);

            if (k === "w" || k === "arrowup") cube.rotateOnWorldAxis(eixoX, -MAP2_KEY_ROT);
            if (k === "a") cube.rotateOnWorldAxis(eixoZ, MAP2_KEY_ROT);
            if (k === "s" || k === "arrowdown") cube.rotateOnWorldAxis(eixoX, MAP2_KEY_ROT);
            if (k === "d") cube.rotateOnWorldAxis(eixoZ, -MAP2_KEY_ROT);
            if (k === "arrowleft") cube.rotateOnWorldAxis(eixoY, MAP2_KEY_ROT);
            if (k === "arrowright") cube.rotateOnWorldAxis(eixoY, -MAP2_KEY_ROT);
        }
    }
});

window.addEventListener("mousemove", (e) => {
    if (mapping != 1) return;
    if (selected !== cube) return;

    const dx = e.movementX * MAP1_MOUSE_SCALE;
    const dy = e.movementY * MAP1_MOUSE_SCALE;

    if (modeSwitches % 2) {
        // Translate mode
        const right = new THREE.Vector3(1, 0, 0).normalize();
        const up = new THREE.Vector3(0, -1, 0).normalize();
        cube.position.addScaledVector(right, dx);
        cube.position.addScaledVector(up, dy);
    } else {
        // Rotate mode
        const q = new THREE.Quaternion();
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx);
        cube.quaternion.premultiply(q);
        q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy);
        cube.quaternion.premultiply(q);
    }
});

window.addEventListener("wheel", (e) => {
    if (mapping != 1) return;
    if (selected !== cube) return;
    e.preventDefault();

    const vz = new THREE.Vector3();
    camera.getWorldDirection(vz);

    if (modeSwitches % 2 === 1) {
        // Translate along camera forward
        const dz = e.deltaY * MAP1_WHEEL_TRANS_SCALE_Z;
        cube.position.addScaledVector(vz, dz);
    } else {
        // Rotate around camera forward
        const rz = e.deltaY * MAP1_WHEEL_ROT_SCALE_Z;
        const qz = new THREE.Quaternion();
        qz.setFromAxisAngle(vz, rz);
        cube.quaternion.premultiply(qz);
    }
}, { passive: false });

// ---------------------------------------------------------------------------
// WebXR bootstrap + condition dispatch
// ---------------------------------------------------------------------------
function setupWebXR() {
    renderer.xr.enabled = true;
    document.body.appendChild(VRButton.createButton(renderer));

    // Target-ray pose (renderer.xr.getController). The target-ray pose points
    // from where the user "aims" — that's what the raycast in getIntersections
    // follows, so it's the pose we need for picking. Using the grip pose here
    // would decouple the visible ray from the attach point and break the
    // direct-grab illusion; the reference-frame decision is documented in the
    // A2 report.
    vrController = renderer.xr.getController(0);
    vrController.add(buildControllerRay());
    scene.add(vrController);

    vrController.addEventListener("selectstart", onSelectStart);
    vrController.addEventListener("selectend",   onSelectEnd);
    vrController.addEventListener("squeezestart", onSqueezeStart);
    vrController.addEventListener("squeezeend",   onSqueezeEnd);
}

function onSelectStart(event) {
    const controller = event.target;
    switch (currentMapping()) {
        case "vr-grab":      startDirectGrab(controller);        break;
        case "vr-trackball": startTrackballRotation(controller); break;
        case "vr-gizmo":     startGizmoDrag(controller);         break;
        default: break;
    }
}

function onSelectEnd(event) {
    const controller = event.target;
    switch (currentMapping()) {
        case "vr-grab":      endDirectGrab(controller);        break;
        case "vr-trackball": endTrackballRotation(controller); break;
        case "vr-gizmo":     endGizmoDrag(controller);         break;
        default: break;
    }
}

function onSqueezeStart(event) {
    if (currentMapping() !== "vr-trackball") return;
    startTrackballTranslation(event.target);
}

function onSqueezeEnd() {
    if (currentMapping() !== "vr-trackball") return;
    endTrackballTranslation();
}

// ---------------------------------------------------------------------------
// Condition 1 — VR direct grab
// ---------------------------------------------------------------------------
function startDirectGrab(controller) {
    const hits = getIntersections(controller, [cube]);
    if (hits.length === 0) return;
    controller.attach(cube);
    controller.userData.selected = cube;
}

function endDirectGrab(controller) {
    if (!controller.userData.selected) return;
    scene.attach(cube);
    controller.userData.selected = null;
}

// ---------------------------------------------------------------------------
// Condition 2 — VR trackball
//
// Rotation is indirect: the cube's orientation follows the controller's
// rotation delta at TRACKBALL_ROTATION_GAIN. Translation is a separate,
// direct step, driven by the squeeze button so the two never interfere.
// ---------------------------------------------------------------------------
function startTrackballRotation(controller) {
    trackballRotationState = {
        lastQuaternion: controller.quaternion.clone(),
    };
}

function endTrackballRotation() {
    trackballRotationState = null;
}

function updateTrackballRotation(controller) {
    if (!trackballRotationState) return;
    const current = controller.quaternion;
    const deltaQ = current.clone().multiply(trackballRotationState.lastQuaternion.clone().invert());
    trackballRotationState.lastQuaternion.copy(current);

    let angle = 2 * Math.acos(Math.min(1, Math.abs(deltaQ.w)));
    if (angle > Math.PI) angle = 2 * Math.PI - angle;
    if (angle < 1e-6) return;

    const axis = new THREE.Vector3(deltaQ.x, deltaQ.y, deltaQ.z);
    if (axis.lengthSq() < 1e-12) return;
    axis.normalize();

    const scaledQ = new THREE.Quaternion().setFromAxisAngle(axis, angle * TRACKBALL_ROTATION_GAIN);
    cube.quaternion.premultiply(scaledQ);
}

function startTrackballTranslation(controller) {
    const pos = new THREE.Vector3();
    controller.getWorldPosition(pos);
    trackballTranslationState = { lastPos: pos };
}

function endTrackballTranslation() {
    trackballTranslationState = null;
}

function updateTrackballTranslation(controller) {
    if (!trackballTranslationState) return;
    const pos = new THREE.Vector3();
    controller.getWorldPosition(pos);
    const delta = new THREE.Vector3().subVectors(pos, trackballTranslationState.lastPos);
    cube.position.add(delta);
    trackballTranslationState.lastPos.copy(pos);
}

// ---------------------------------------------------------------------------
// Condition 3 — VR gizmo
//
// Six handles attached to the cube's position, world-aligned: three arrows
// for constrained translation along X/Y/Z, three rings for constrained
// rotation about X/Y/Z. Selecting a handle locks all further hand motion to
// that single axis (translation) or single rotation (rotation) — sideways
// wobble in the hand is discarded by the projection math, not just visually
// hidden.
// ---------------------------------------------------------------------------
function buildGizmo() {
    const group = new THREE.Group();
    group.name = "gizmo";
    group.visible = false;

    const axisDirs = [
        { name: "tx", dir: new THREE.Vector3(1, 0, 0), color: GIZMO_COLOR_X },
        { name: "ty", dir: new THREE.Vector3(0, 1, 0), color: GIZMO_COLOR_Y },
        { name: "tz", dir: new THREE.Vector3(0, 0, 1), color: GIZMO_COLOR_Z },
    ];
    for (const a of axisDirs) {
        group.add(buildGizmoArrow(a.dir, a.color, a.name));
    }

    const ringAxes = [
        { name: "rx", axis: new THREE.Vector3(1, 0, 0), color: GIZMO_COLOR_X },
        { name: "ry", axis: new THREE.Vector3(0, 1, 0), color: GIZMO_COLOR_Y },
        { name: "rz", axis: new THREE.Vector3(0, 0, 1), color: GIZMO_COLOR_Z },
    ];
    for (const r of ringAxes) {
        group.add(buildGizmoRing(r.axis, r.color, r.name));
    }

    return group;
}

function buildGizmoArrow(dir, color, name) {
    const sub = new THREE.Group();
    sub.name = name;

    const shaftGeo = new THREE.CylinderGeometry(GIZMO_ARROW_SHAFT_R, GIZMO_ARROW_SHAFT_R, GIZMO_ARROW_LENGTH * 0.8, 10);
    const shaftMat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: GIZMO_BASE_OPACITY,
    });
    const shaft = new THREE.Mesh(shaftGeo, shaftMat);
    alignMeshAlong(shaft, dir);
    shaft.position.copy(dir).multiplyScalar(GIZMO_ARROW_LENGTH * 0.4);
    shaft.userData.handle = name;
    shaft.userData.axis = dir.clone();
    sub.add(shaft);

    const headGeo = new THREE.ConeGeometry(GIZMO_ARROW_HEAD_R, GIZMO_ARROW_HEAD_L, 12);
    const headMat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: GIZMO_BASE_OPACITY,
    });
    const head = new THREE.Mesh(headGeo, headMat);
    alignMeshAlong(head, dir);
    head.position.copy(dir).multiplyScalar(GIZMO_ARROW_LENGTH * 0.8 + GIZMO_ARROW_HEAD_L * 0.5);
    head.userData.handle = name;
    head.userData.axis = dir.clone();
    sub.add(head);

    return sub;
}

function buildGizmoRing(axis, color, name) {
    const geo = new THREE.TorusGeometry(GIZMO_RING_RADIUS, GIZMO_RING_TUBE, 10, 56);
    const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: GIZMO_BASE_OPACITY, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    alignMeshAlong(mesh, axis, /* fromZ */ true);
    mesh.userData.handle = name;
    mesh.userData.axis = axis.clone();
    return mesh;
}

function alignMeshAlong(mesh, dir, fromZ) {
    const from = fromZ ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(from, dir.clone().normalize());
    mesh.quaternion.copy(q);
}

function setHandleHighlight(mesh, on) {
    if (!mesh || !mesh.material) return;
    mesh.material.opacity = on ? GIZMO_HOVER_OPACITY : GIZMO_BASE_OPACITY;
}

function updateGizmo() {
    if (!gizmoGroup) return;
    const inGizmo = currentMapping() === "vr-gizmo" && renderer.xr.isPresenting;

    if (!inGizmo) {
        gizmoGroup.visible = false;
        if (gizmoHoveredHandle) {
            setHandleHighlight(gizmoHoveredHandle, false);
            gizmoHoveredHandle = null;
        }
        return;
    }

    gizmoGroup.visible = true;
    gizmoGroup.position.copy(cube.position);

    if (!gizmoDragState) {
        updateGizmoHover();
    } else {
        updateGizmoDrag();
    }
}

function updateGizmoHover() {
    if (!vrController) return;
    const hits = raycastGizmo(vrController);
    const newHover = hits.length > 0 ? hits[0].object : null;
    if (newHover === gizmoHoveredHandle) return;
    setHandleHighlight(gizmoHoveredHandle, false);
    setHandleHighlight(newHover, true);
    gizmoHoveredHandle = newHover;
}

function startGizmoDrag(controller) {
    const hits = raycastGizmo(controller);
    if (hits.length === 0) return;
    const handle = hits[0].object;
    const name = handle.userData.handle;
    const axis = handle.userData.axis.clone();

    const controllerPos = new THREE.Vector3();
    controller.getWorldPosition(controllerPos);

    if (name.startsWith("t")) {
        const origin = cube.position.clone();
        const t0 = projectPointOnAxis(controllerPos, origin, axis);
        gizmoDragState = {
            type: "translate",
            axis,
            origin,
            t0,
            initialCubePosition: cube.position.clone(),
        };
    } else if (name.startsWith("r")) {
        const planeOrigin = cube.position.clone();
        const planeNormal = axis.clone();
        const frame = planeFrame(controllerPos, planeOrigin, planeNormal);
        gizmoDragState = {
            type: "rotate",
            axis,
            planeOrigin,
            planeNormal,
            u: frame.u,
            w: frame.w,
            theta0: frame.theta0,
            initialCubeQuaternion: cube.quaternion.clone(),
        };
    }
}

function updateGizmoDrag() {
    if (!gizmoDragState || !vrController) return;
    const controllerPos = new THREE.Vector3();
    vrController.getWorldPosition(controllerPos);

    if (gizmoDragState.type === "translate") {
        const t = projectPointOnAxis(controllerPos, gizmoDragState.origin, gizmoDragState.axis);
        const delta = t - gizmoDragState.t0;
        cube.position.copy(gizmoDragState.initialCubePosition)
            .addScaledVector(gizmoDragState.axis, delta);
    } else if (gizmoDragState.type === "rotate") {
        const theta = angleOnPlane(
            controllerPos,
            gizmoDragState.planeOrigin,
            gizmoDragState.planeNormal,
            gizmoDragState.u,
            gizmoDragState.w
        );
        const dTheta = theta - gizmoDragState.theta0;
        const q = new THREE.Quaternion().setFromAxisAngle(gizmoDragState.axis, dTheta);
        cube.quaternion.copy(gizmoDragState.initialCubeQuaternion).premultiply(q);
    }
}

function endGizmoDrag() {
    gizmoDragState = null;
}

function projectPointOnAxis(point, axisOrigin, axisDir) {
    const v = new THREE.Vector3().subVectors(point, axisOrigin);
    return v.dot(axisDir);
}

function planeFrame(point, planeOrigin, planeNormal) {
    const v = new THREE.Vector3().subVectors(point, planeOrigin);
    v.addScaledVector(planeNormal, -v.dot(planeNormal));
    let ref = new THREE.Vector3(1, 0, 0);
    if (Math.abs(planeNormal.dot(ref)) > 0.9) ref.set(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(planeNormal, ref).normalize();
    const w = new THREE.Vector3().crossVectors(planeNormal, u).normalize();
    const theta0 = Math.atan2(v.dot(w), v.dot(u));
    return { u, w, theta0 };
}

function angleOnPlane(point, planeOrigin, planeNormal, u, w) {
    const v = new THREE.Vector3().subVectors(point, planeOrigin);
    v.addScaledVector(planeNormal, -v.dot(planeNormal));
    return Math.atan2(v.dot(w), v.dot(u));
}

// ---------------------------------------------------------------------------
// Ray helpers
// ---------------------------------------------------------------------------
function buildControllerRay() {
    const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1),
    ]);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: RAY_COLOR }));
    line.name = "ray";
    line.scale.z = RAY_LENGTH_SCALE;
    return line;
}

function getIntersections(controller, objects) {
    const tempMatrix = new THREE.Matrix4();
    tempMatrix.identity().extractRotation(controller.matrixWorld);

    const raycaster = new THREE.Raycaster();
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    return raycaster.intersectObjects(objects, false);
}

function raycastGizmo(controller) {
    if (!gizmoGroup || !gizmoGroup.visible) return [];
    const tempMatrix = new THREE.Matrix4();
    tempMatrix.identity().extractRotation(controller.matrixWorld);

    const raycaster = new THREE.Raycaster();
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    return raycaster
        .intersectObjects([gizmoGroup], true)
        .filter((h) => h.object.userData && h.object.userData.handle);
}

// ---------------------------------------------------------------------------
// State reset — called between trials and when the condition select changes
// ---------------------------------------------------------------------------
function resetVrManipulationState() {
    if (vrController && vrController.userData.selected) {
        scene.attach(cube);
        vrController.userData.selected = null;
    }
    trackballRotationState = null;
    trackballTranslationState = null;
    gizmoDragState = null;
    if (gizmoHoveredHandle) {
        setHandleHighlight(gizmoHoveredHandle, false);
        gizmoHoveredHandle = null;
    }
}

mappingSelect.addEventListener("change", resetVrManipulationState);

// ---------------------------------------------------------------------------
// Per-frame dispatch
// ---------------------------------------------------------------------------
function updateControlMapping(/* delta */) {
    // Refresh the cached condition value each frame. The desktop event
    // handlers read `mapping` directly, so this is what makes them branch on
    // the currently-selected condition without re-querying the DOM on every
    // mouse move or keydown.
    mapping = currentMapping();
}

function updateVrConditions() {
    if (!vrController) return;
    const condition = currentMapping();

    if (condition === "vr-trackball") {
        if (trackballRotationState) updateTrackballRotation(vrController);
        if (trackballTranslationState) updateTrackballTranslation(vrController);
    }

    // Gizmo visual state must update every frame in XR, even when nothing is
    // being dragged (hover highlight).
    updateGizmo();
}

// ---------------------------------------------------------------------------
// Render loop — WebXR requires renderer.setAnimationLoop, not rAF.
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();

function animate() {
    renderer.setAnimationLoop(() => {
        clock.getDelta();

        updateControlMapping();
        updateVrConditions();

        pathLength += cube.position.distanceTo(lastCubePosition);
        lastCubePosition.copy(cube.position);

        updateStatus();
        renderer.render(scene, camera);
    });
}

main();

