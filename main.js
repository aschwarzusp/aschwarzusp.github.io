// =============================================================================
// MAC0623 — Assignment 3 — Navigation in VR
//
// Extends the A2 codebase with two navigation techniques:
//   Technique 1 — World-in-Miniature (WIM):
//       A scaled, live-updating clone of the environment is held in the left
//       hand (visible while the left grip is held). A "you are here" marker
//       inside the miniature can be grabbed with the right controller and
//       moved; on release, the viewpoint jumps so the head lands on the
//       marker's target position.
//
//   Technique 2 — Joystick locomotion:
//       Continuous, camera-relative movement driven by the left thumbstick.
//       Analog speed, floor-clamped. This is the "single egocentric frame"
//       technique predicted to be faster and more direct than WIM on visible-
//       beacon trials, at the cost of vection exposure.
//
// Task: waypoint navigation. A beacon spawns somewhere in the environment.
// The participant navigates until within CONFIRM_RADIUS and confirms.
//
// Instrumentation: one CSV row per trial, with path_ratio as the standard
// wayfinding-efficiency metric.
// =============================================================================

import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";

// ---------------------------------------------------------------------------
// Named constants — environment
// ---------------------------------------------------------------------------
const BACKGROUND_COLOR = 0x1a1a1a;
const HEMISPHERE_SKY_COLOR = 0xffffff;
const HEMISPHERE_GROUND_COLOR = 0x444444;
const DIRECTIONAL_LIGHT_COLOR = 0xffffff;
const HEMISPHERE_LIGHT_INTENSITY = 1.2;
const DIRECTIONAL_LIGHT_INTENSITY = 0.8;
const DIRECTIONAL_LIGHT_POSITION = [5, 10, 7];

// Environment: 20 x 20 units. Large enough that walking across it in real
// life would take well more than a couple of steps; the A1/A2 docking scene
// (6 x 6) fits entirely inside this floor.
const ENV_SIZE = 20;
const GRID_DIVISIONS = 20;
const GRID_COLOR_CENTER_LINE = 0x444444;
const GRID_COLOR_LINES = 0x2a2a2a;

// Landmarks: three distinguishable large shapes. Landmarks matter more than
// geometry complexity for wayfinding — three large colored shapes give the
// participant real spatial anchors without building an expensive scene.
const PILLAR_COLOR = 0xff4444;
const PILLAR_POSITION = [-6, -6];
const PILLAR_RADIUS = 0.6;
const PILLAR_HEIGHT = 4.0;

const ARCH_COLOR = 0x4488ff;
const ARCH_POSITION = [6, -6];
const ARCH_WIDTH = 4.0;
const ARCH_HEIGHT = 3.0;
const ARCH_THICKNESS = 0.4;

const WALL_COLOR = 0xffcc00;
const WALL_POSITION = [0, 7];
const WALL_WIDTH = 8.0;
const WALL_HEIGHT = 3.0;
const WALL_THICKNESS = 0.3;

// Beacon: the target for waypoint navigation.
const BEACON_COLOR = 0x00ff88;
const BEACON_RADIUS = 0.3;
const BEACON_HEIGHT = 1.5;
const BEACON_SPAWN_RADIUS = 8.0;
const BEACON_MIN_DISTANCE_FROM_USER = 4.0;

// Confirm radius: within this distance of the beacon, the trial can be
// confirmed. Chosen at 1.0 units — forgiving enough that the participant does
// not have to land exactly on the beacon, tight enough that navigation is
// actually required. Scale: 1.0 is 5% of the 20-unit floor diagonal, which is
// comparable to A1/A2's 0.05 position tolerance scaled to the larger task.
const CONFIRM_RADIUS = 1.0;

// Camera / rig
const CAMERA_FOV_DEG = 70;
const CAMERA_NEAR = 0.05;
const CAMERA_FAR = 100;
const EYE_HEIGHT = 1.6;

// WIM constants
const WIM_SCALE_FACTOR = 0.35 / ENV_SIZE; // ~0.0175 for ENV_SIZE = 20
const WIM_LOCAL_POSITION = [0, 0.12, -0.05];
const MARKER_HEIGHT = 0.04;
const MARKER_COLOR = 0xff00ff;

// Joystick locomotion constants
//
// MAX_SPEED = 2.5 units/s. The environment is 20 units across, so a full
// traversal at max speed takes about 8 s — slow enough to steer, fast enough
// that trials don't drag. 2.5 sits in the common VR comfort band (~1.5–3 m/s).
//
// DEADZONE = 0.15 on the (x, y) magnitude, not per-axis, so diagonal input
// near the deadzone edge isn't biased toward one axis.
const JOYSTICK_MAX_SPEED = 2.5;
const JOYSTICK_DEADZONE = 0.15;
const JOYSTICK_DEADZONE_SQ = JOYSTICK_DEADZONE * JOYSTICK_DEADZONE;

// Controller ray
const RAY_COLOR = 0xffffff;
const RAY_LENGTH_SCALE = 1.5;

// ---------------------------------------------------------------------------
// Module-scope state
// ---------------------------------------------------------------------------
let scene, camera, renderer;
let worldGroup, rigGroup;
let gripL, gripR;
let mini, wimMarker, beacon, beaconClone;
let vrController = null; // right controller target-ray pose

// WIM state
let wimGrabState = null;

// Trial state
let trialNumber = 0;
let trialStartTime = 0;
let pathLength = 0;
let lastViewpointPosition = new THREE.Vector3();
let currentBeaconPosition = new THREE.Vector3();
let trialStartPosition = new THREE.Vector3();
let straightLineDistance = 0;

const rows = [];
const CSV_HEADER = [
    "participant_id",
    "technique",
    "trial_number",
    "presentation_order",
    "completion_time_s",
    "path_length",
    "straight_line_distance",
    "path_ratio",
];

const presentationOrderByTechnique = { "1": 0, "2": 0 };

// Reusable temporaries
const _tmpVec = new THREE.Vector3();
const _camForward = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _inputDir = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _deltaClock = new THREE.Clock();

// ---------------------------------------------------------------------------
// buildEnvironment()
// ---------------------------------------------------------------------------
function buildEnvironment() {
    const world = new THREE.Group();
    world.name = "world";

    // Lights (full-size only — the miniature clone removes its own lights).
    world.add(new THREE.HemisphereLight(
        HEMISPHERE_SKY_COLOR, HEMISPHERE_GROUND_COLOR, HEMISPHERE_LIGHT_INTENSITY
    ));
    const dirLight = new THREE.DirectionalLight(
        DIRECTIONAL_LIGHT_COLOR, DIRECTIONAL_LIGHT_INTENSITY
    );
    dirLight.position.set(...DIRECTIONAL_LIGHT_POSITION);
    world.add(dirLight);

    // Floor
    const floorGeo = new THREE.PlaneGeometry(ENV_SIZE, ENV_SIZE);
    const floorMat = new THREE.MeshStandardMaterial({
        color: 0x333338,
        side: THREE.DoubleSide,
        roughness: 0.9,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.name = "floor";
    world.add(floor);

    // Grid helper for spatial reference
    const grid = new THREE.GridHelper(
        ENV_SIZE, GRID_DIVISIONS, GRID_COLOR_CENTER_LINE, GRID_COLOR_LINES
    );
    grid.position.y = 0.01;
    world.add(grid);

    // Landmark 1: tall red pillar
    const pillarGeo = new THREE.CylinderGeometry(
        PILLAR_RADIUS, PILLAR_RADIUS, PILLAR_HEIGHT, 16
    );
    const pillarMat = new THREE.MeshStandardMaterial({ color: PILLAR_COLOR });
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.set(PILLAR_POSITION[0], PILLAR_HEIGHT / 2, PILLAR_POSITION[1]);
    pillar.name = "pillar";
    world.add(pillar);

    // Landmark 2: blue arch
    const archGroup = new THREE.Group();
    archGroup.name = "arch";
    const archMat = new THREE.MeshStandardMaterial({ color: ARCH_COLOR });
    const legGeo = new THREE.BoxGeometry(ARCH_THICKNESS, ARCH_HEIGHT, ARCH_THICKNESS);
    const leftLeg = new THREE.Mesh(legGeo, archMat);
    leftLeg.position.set(-ARCH_WIDTH / 2, ARCH_HEIGHT / 2, 0);
    archGroup.add(leftLeg);
    const rightLeg = new THREE.Mesh(legGeo, archMat);
    rightLeg.position.set(ARCH_WIDTH / 2, ARCH_HEIGHT / 2, 0);
    archGroup.add(rightLeg);
    const topGeo = new THREE.BoxGeometry(
        ARCH_WIDTH + ARCH_THICKNESS, ARCH_THICKNESS, ARCH_THICKNESS
    );
    const top = new THREE.Mesh(topGeo, archMat);
    top.position.set(0, ARCH_HEIGHT, 0);
    archGroup.add(top);
    archGroup.position.set(ARCH_POSITION[0], 0, ARCH_POSITION[1]);
    world.add(archGroup);

    // Landmark 3: yellow wall
    const wallGeo = new THREE.BoxGeometry(WALL_WIDTH, WALL_HEIGHT, WALL_THICKNESS);
    const wallMat = new THREE.MeshStandardMaterial({ color: WALL_COLOR });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(WALL_POSITION[0], WALL_HEIGHT / 2, WALL_POSITION[1]);
    wall.name = "wall";
    world.add(wall);

    // Beacon (target)
    const beaconGeo = new THREE.CylinderGeometry(
        BEACON_RADIUS, BEACON_RADIUS, BEACON_HEIGHT, 12
    );
    const beaconMat = new THREE.MeshStandardMaterial({
        color: BEACON_COLOR,
        emissive: BEACON_COLOR,
        emissiveIntensity: 0.6,
    });
    const beaconMesh = new THREE.Mesh(beaconGeo, beaconMat);
    beaconMesh.name = "beacon";
    beaconMesh.visible = false;
    world.add(beaconMesh);

    return { world, beacon: beaconMesh };
}

// ---------------------------------------------------------------------------
// buildWim()
//
// Clones the fully-built world. Geometry and materials are shared, so the
// clone costs almost no memory. Lights are stripped from the clone because
// a scaled-down light would produce the wrong illumination. The beacon clone
// is kept but synced manually each trial.
// ---------------------------------------------------------------------------
function buildWim(world) {
    const mini = world.clone(true);
    mini.name = "mini";

    // Remove cloned lights — lights stay full-size only.
    const clonedLights = [];
    mini.traverse((o) => { if (o.isLight) clonedLights.push(o); });
    clonedLights.forEach((l) => l.removeFromParent());

    // The beacon clone is used to show the target inside the miniature.
    const beaconClone = mini.getObjectByName("beacon");
    if (beaconClone) beaconClone.visible = true;

    mini.scale.setScalar(WIM_SCALE_FACTOR);
    mini.position.set(...WIM_LOCAL_POSITION);
    mini.visible = false; // shown while left grip is held

    // "You are here" marker. Its local scale is 1 / WIM_SCALE_FACTOR so it
    // appears at a comfortable size in the hand despite the miniature's shrink.
    // Base sits on the miniature's floor.
    const markerGeom = new THREE.ConeGeometry(MARKER_HEIGHT / 3, MARKER_HEIGHT, 12);
    markerGeom.translate(0, MARKER_HEIGHT / 2, 0);
    const markerMat = new THREE.MeshStandardMaterial({
        color: MARKER_COLOR,
        emissive: MARKER_COLOR,
        emissiveIntensity: 0.4,
    });
    const marker = new THREE.Mesh(markerGeom, markerMat);
    marker.name = "wimMarker";
    marker.scale.setScalar(1 / WIM_SCALE_FACTOR);
    mini.add(marker);

    return { mini, marker, beaconClone };
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------
function main() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKGROUND_COLOR);

    // World group — everything that can be navigated to lives here.
    const built = buildEnvironment();
    worldGroup = built.world;
    beacon = built.beacon;
    scene.add(worldGroup);

    // Rig group — camera + controllers. Moving this moves the viewpoint.
    // In WebXR the headset overwrites the camera's pose each frame, so the
    // only way to move the user is to move the rig.
    rigGroup = new THREE.Group();
    rigGroup.name = "rig";
    scene.add(rigGroup);

    camera = new THREE.PerspectiveCamera(
        CAMERA_FOV_DEG,
        window.innerWidth / window.innerHeight,
        CAMERA_NEAR,
        CAMERA_FAR
    );
    camera.position.set(0, EYE_HEIGHT, 0);
    rigGroup.add(camera);

    // Build the WIM after the world is fully built, so the clone captures
    // every landmark and the beacon.
    const wimBuilt = buildWim(worldGroup);
    mini = wimBuilt.mini;
    wimMarker = wimBuilt.marker;
    beaconClone = wimBuilt.beaconClone;

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    window.addEventListener("resize", handleWindowResize);

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
// WebXR bootstrap
// ---------------------------------------------------------------------------
function setupWebXR() {
    renderer.xr.enabled = true;
    document.body.appendChild(VRButton.createButton(renderer));

    // Left controller grip: holds the WIM miniature.
    gripL = renderer.xr.getControllerGrip(0);
    rigGroup.add(gripL);
    gripL.add(mini);

    // Right controller grip (unused for now, but available for symmetric
    // input-source handling).
    gripR = renderer.xr.getControllerGrip(1);
    rigGroup.add(gripR);

    // Right controller target-ray pose: used for WIM marker grabbing.
    vrController = renderer.xr.getController(1);
    vrController.add(buildControllerRay());
    rigGroup.add(vrController);

    vrController.addEventListener("selectstart", onSelectStart);
    vrController.addEventListener("selectend", onSelectEnd);

    // Left squeeze shows / hides the miniature. Showing it only while held
    // keeps it from blocking the view during joystick locomotion.
    gripL.addEventListener("squeezestart", () => { mini.visible = true; });
    gripL.addEventListener("squeezeend", () => { mini.visible = false; });
}

function buildControllerRay() {
    const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1),
    ]);
    const line = new THREE.Line(
        geometry, new THREE.LineBasicMaterial({ color: RAY_COLOR })
    );
    line.name = "ray";
    line.scale.z = RAY_LENGTH_SCALE;
    return line;
}

// ---------------------------------------------------------------------------
// UI references
// ---------------------------------------------------------------------------
const participantIdInput = document.getElementById("participantId");
const techniqueSelect = document.getElementById("techniqueSelect");
const trialCountEl = document.getElementById("trialCount");
const confirmBtn = document.getElementById("confirmBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");

function currentTechnique() {
    return techniqueSelect.value;
}

// ---------------------------------------------------------------------------
// Trial lifecycle
// ---------------------------------------------------------------------------
function startTrial() {
    trialStartTime = performance.now();
    pathLength = 0;

    // Record starting viewpoint position (head position, not rig origin —
    // the user stands off the rig's center in room-scale VR).
    camera.getWorldPosition(trialStartPosition);
    lastViewpointPosition.copy(trialStartPosition);

    spawnBeacon();

    // Sync the beacon clone inside the miniature.
    if (beaconClone) {
        beaconClone.position.copy(beacon.position);
        beaconClone.visible = true;
    }

    // Sync the WIM marker to the user's current position.
    syncWimMarker();

    trialCountEl.textContent = `Trial ${trialNumber + 1}`;

    resetInteractionState();
}

function spawnBeacon() {
    // Pick a position on the floor within the spawn radius, at least
    // BEACON_MIN_DISTANCE_FROM_USER away from the trial start, so the beacon
    // always requires real navigation rather than a lean or a single step.
    let pos;
    let attempts = 0;
    do {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.sqrt(Math.random()) * BEACON_SPAWN_RADIUS;
        pos = new THREE.Vector3(
            Math.cos(angle) * radius,
            0,
            Math.sin(angle) * radius
        );
        attempts++;
    } while (
        Math.hypot(
            pos.x - trialStartPosition.x,
            pos.z - trialStartPosition.z
        ) < BEACON_MIN_DISTANCE_FROM_USER && attempts < 50
    );

    beacon.position.set(pos.x, BEACON_HEIGHT / 2, pos.z);
    beacon.visible = true;
    currentBeaconPosition.copy(pos);

    straightLineDistance = Math.hypot(
        trialStartPosition.x - pos.x,
        trialStartPosition.z - pos.z
    );
}

function confirmTrial() {
    const completionTimeS = (performance.now() - trialStartTime) / 1000;
    const pathRatio = straightLineDistance > 1e-6
        ? pathLength / straightLineDistance
        : 1.0;

    const technique = currentTechnique();
    trialNumber += 1;
    presentationOrderByTechnique[technique] =
        (presentationOrderByTechnique[technique] || 0) + 1;

    rows.push({
        participant_id: participantIdInput.value.trim() || "UNKNOWN",
        technique: technique,
        trial_number: trialNumber,
        presentation_order: presentationOrderByTechnique[technique],
        completion_time_s: completionTimeS.toFixed(3),
        path_length: pathLength.toFixed(4),
        straight_line_distance: straightLineDistance.toFixed(4),
        path_ratio: pathRatio.toFixed(4),
    });

    startTrial();
}

confirmBtn.addEventListener("click", confirmTrial);
window.addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmTrial();
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
function buildCsv() {
    const lines = [CSV_HEADER.join(",")];
    for (const row of rows) {
        lines.push(CSV_HEADER.map((k) => row[k]).join(","));
    }
    return lines.join("\n");
}

downloadBtn.addEventListener("click", () => {
    const csv = buildCsv();
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const pid = participantIdInput.value.trim() || "UNKNOWN";
    a.href = url;
    a.download = `A3_${pid}_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
});

// ---------------------------------------------------------------------------
// WIM marker sync
//
// Called every frame while not dragging. Converts the head's world position
// into the world-group's local coordinates (which are also the miniature's
// local coordinates, since the miniature is a clone of the world group) and
// drops the marker there on the floor.
// ---------------------------------------------------------------------------
function syncWimMarker() {
    if (!wimMarker || wimGrabState) return;
    camera.getWorldPosition(_tmpVec);
    worldGroup.worldToLocal(_tmpVec);
    wimMarker.position.set(_tmpVec.x, 0, _tmpVec.z);
}

// ---------------------------------------------------------------------------
// Interaction dispatch
// ---------------------------------------------------------------------------
function onSelectStart(event) {
    if (currentTechnique() === "1") {
        startWimGrab(event.target);
    }
    // Technique 2 uses the left thumbstick; the trigger does nothing.
}

function onSelectEnd(event) {
    if (currentTechnique() === "1") {
        endWimGrab(event.target);
    }
}

function resetInteractionState() {
    wimGrabState = null;
}

// ---------------------------------------------------------------------------
// Technique 1 — World-in-Miniature (WIM)
// ---------------------------------------------------------------------------
function startWimGrab(controller) {
    // Raycast into the miniature; only the marker is grabbable.
    const hits = getIntersections(controller, [wimMarker], true);
    if (hits.length === 0) return;
    controller.attach(wimMarker);
    wimGrabState = { marker: wimMarker, controller };
}

function endWimGrab(controller) {
    if (!wimGrabState) return;

    // Put the marker back into the miniature's coordinate frame, keeping it
    // on the floor. `mini.attach` preserves the world transform, so the
    // marker's local position now encodes where the user dropped it.
    mini.attach(wimMarker);
    wimMarker.position.y = 0;

    // The miniature's local frame is identical to the world group's local
    // frame (the miniature is a clone of the world group). So the marker's
    // position, read in miniature-local coordinates, is directly the target
    // position in world-group-local coordinates.
    const targetLocal = new THREE.Vector3(
        wimMarker.position.x, 0, wimMarker.position.z
    );
    const targetWorld = worldGroup.localToWorld(targetLocal);

    // Shift the rig so the HEAD lands on the target. The user usually stands
    // off the rig's center, so we correct by the difference between the
    // target and the current head position, not the rig origin.
    camera.getWorldPosition(_tmpVec);
    const delta = new THREE.Vector3().subVectors(targetWorld, _tmpVec);
    delta.y = 0;
    rigGroup.position.add(delta);

    // The WIM move is a jump. Count it in path_length. Then re-sync the
    // per-frame tracker so the next frame doesn't double-count the jump as
    // physical head movement.
    pathLength += delta.length();
    camera.getWorldPosition(lastViewpointPosition);

    wimGrabState = null;
    syncWimMarker();
}

// ---------------------------------------------------------------------------
// Technique 2 — Joystick locomotion
//
// Reads the left controller's thumbstick from the XR input source's gamepad.
// Movement is camera-relative: pushing the stick "up" moves the user where
// they are looking, projected onto the floor. Speed is analog, scaled by the
// stick's magnitude. The rig is clamped to the floor bounds.
// ---------------------------------------------------------------------------

function readLeftThumbstick() {
    const session = renderer.xr.getSession();
    if (!session) return { x: 0, y: 0 };

    for (const source of session.inputSources) {
        if (source.handedness !== "left") continue;
        if (!source.gamepad || !source.gamepad.axes) continue;

        const axes = source.gamepad.axes;
        const rawX = axes.length > 0 ? axes[0] : 0;
        const rawY = axes.length > 1 ? axes[1] : 0;

        // Deadzone on the (x, y) magnitude, not per-axis, so diagonal input
        // near the deadzone edge isn't biased toward one axis.
        const magSq = rawX * rawX + rawY * rawY;
        if (magSq < JOYSTICK_DEADZONE_SQ) return { x: 0, y: 0 };

        // Flip Y so pushing the stick up (negative rawY on most hardware)
        // produces forward motion.
        return { x: rawX, y: -rawY };
    }
    return { x: 0, y: 0 };
}

function applyJoystickLocomotion(dt) {
    const stick = readLeftThumbstick();
    const magnitude = Math.hypot(stick.x, stick.y);

    if (magnitude < JOYSTICK_DEADZONE) return;

    // Clamp to 1.0 — some controllers report slightly > 1 on diagonals.
    const clampedMag = Math.min(magnitude, 1.0);

    // Camera forward, flattened onto the floor. If the user is looking
    // straight up or down, the projected forward is near zero and we skip
    // movement — otherwise the direction would be unstable.
    camera.getWorldDirection(_camForward);
    _camForward.y = 0;
    if (_camForward.lengthSq() < 1e-8) return;
    _camForward.normalize();

    // Camera right = world-up × forward (right-handed, Y-up). This gives a
    // vector pointing to the user's right.
    _camRight.crossVectors(_worldUp, _camForward).normalize();

    // Combine. stick.y (forward/back) drives camForward; stick.x (strafe)
    // drives camRight. Normalize the resulting direction so diagonal movement
    // isn't faster than straight movement — magnitude is preserved from the
    // stick, not from the vector sum.
    _inputDir
        .set(0, 0, 0)
        .addScaledVector(_camForward, stick.y)
        .addScaledVector(_camRight, stick.x);

    if (_inputDir.lengthSq() < 1e-8) return;
    _inputDir.normalize();

    const speed = JOYSTICK_MAX_SPEED * clampedMag;
    const displacement = _inputDir.multiplyScalar(speed * dt);

    rigGroup.position.add(displacement);

    // Clamp the rig to the floor bounds, leaving a 1-unit margin so the user
    // cannot wander off the edge of the grid.
    const half = ENV_SIZE / 2 - 1.0;
    rigGroup.position.x = THREE.MathUtils.clamp(rigGroup.position.x, -half, half);
    rigGroup.position.z = THREE.MathUtils.clamp(rigGroup.position.z, -half, half);
}

// ---------------------------------------------------------------------------
// Raycast helper (target-ray pose of a controller)
// ---------------------------------------------------------------------------
function getIntersections(controller, objects, recursive) {
    const tempMatrix = new THREE.Matrix4();
    tempMatrix.identity().extractRotation(controller.matrixWorld);

    const raycaster = new THREE.Raycaster();
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    return raycaster.intersectObjects(objects, recursive);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
function isWithinConfirmRadius() {
    camera.getWorldPosition(_tmpVec);
    const dist = Math.hypot(
        _tmpVec.x - currentBeaconPosition.x,
        _tmpVec.z - currentBeaconPosition.z
    );
    return dist <= CONFIRM_RADIUS;
}

function updateStatus() {
    const within = isWithinConfirmRadius();
    statusEl.textContent = within
        ? `Within confirm radius (${CONFIRM_RADIUS}) — press Enter / Confirm`
        : `Navigate to beacon (radius ${CONFIRM_RADIUS})`;
    statusEl.classList.toggle("in-tolerance", within);
}

// ---------------------------------------------------------------------------
// Per-frame update
//
// path_length is the total distance the viewpoint traveled during the trial.
// Both techniques feed the same rule: accumulate actual head displacement
// each frame, and additionally add the jump distance at the moment of a WIM
// jump (in endWimGrab). The WIM jump also re-syncs lastViewpointPosition, so
// the jump is not double-counted as physical walking.
// ---------------------------------------------------------------------------
function updateNavigation() {
    const dt = _deltaClock.getDelta();
    const technique = currentTechnique();

    if (technique === "1") {
        syncWimMarker();
    } else if (technique === "2") {
        applyJoystickLocomotion(dt);
    }

    // Accumulate physical head movement. This is the same rule for both
    // techniques, which keeps path_length comparable.
    camera.getWorldPosition(_tmpVec);
    pathLength += _tmpVec.distanceTo(lastViewpointPosition);
    lastViewpointPosition.copy(_tmpVec);
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
function animate() {
    renderer.setAnimationLoop(() => {
        updateNavigation();
        updateStatus();
        renderer.render(scene, camera);
    });
}

main();
