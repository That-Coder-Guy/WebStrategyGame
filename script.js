// Ensure strict mode and basic error handling
'use strict';

// --- Configuration ---
const MAP_SIZE = 64; // As requested (Warning: Performance intensive!)
const TILE_SIZE = 1;   // Size of each square tile in world units
const NOISE_SCALE = 100; // Controls the "zoom" level of the Perlin noise. Larger = larger features.
const CAMERA_FRUSTUM_SIZE = 100; // Determines the initial "zoom" level of the orthographic camera
const CAMERA_ANGLE_X = -Math.PI / 6; // Angle down towards the ground (approx 30 degrees)
const CAMERA_ANGLE_Y = Math.PI / 4;  // Angle sideways (approx 45 degrees) for isometric view
const DAY_NIGHT_SPEED = 0.0001; // Speed of the directional light rotation

// Tile type definitions (ordered by elevation)
const TILE_TYPES = {
    STONE: { color: 0x888888, minHeight: 0.80, baseElevation: 1.0 },
    GRASS_TREE: { color: 0x228B22, minHeight: 0.65, baseElevation: 0.5 }, // ForestGreen
    GRASS: { color: 0x32CD32, minHeight: 0.45, baseElevation: 0.4 },    // LimeGreen
    SAND: { color: 0xF4A460, minHeight: 0.35, baseElevation: 0.1 },     // SandyBrown
    WATER: { color: 0x1E90FF, minHeight: 0.0, baseElevation: -0.5 }      // DodgerBlue
};

// --- Global Variables ---
let scene, camera, renderer, noiseGenerator;
let directionalLight;
let mapGroup; // To hold all map tiles for easier management

// Mouse/Touch Dragging State
let isDragging = false;
let previousMousePosition = { x: 0, y: 0 };

// --- Initialization ---
function init() {
    // Scene setup
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xaaaaaa); // Light grey background

    // Noise Generator
    noiseGenerator = new SimplexNoise();

    // Renderer setup
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true; // Enable shadows
    renderer.shadowMap.type = THREE.PCFSoftShadowMap; // Softer shadows
    document.getElementById('game-container').appendChild(renderer.domElement);

    // Camera setup (Orthographic)
    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.OrthographicCamera(
        CAMERA_FRUSTUM_SIZE * aspect / -2,
        CAMERA_FRUSTUM_SIZE * aspect / 2,
        CAMERA_FRUSTUM_SIZE / 2,
        CAMERA_FRUSTUM_SIZE / -2,
        1,       // Near clipping plane
        2000     // Far clipping plane (needs to see the whole map diagonally)
    );

    // Position and angle the camera
    const cameraDistance = MAP_SIZE * TILE_SIZE * 0.7; // Start reasonably far out
    camera.position.set(
        cameraDistance * Math.sin(CAMERA_ANGLE_Y) * Math.cos(CAMERA_ANGLE_X),
        cameraDistance * Math.sin(CAMERA_ANGLE_X), // Negative Y is up in Three.js coord system if rotated this way? No, positive Y is up.
        cameraDistance * Math.cos(CAMERA_ANGLE_Y) * Math.cos(CAMERA_ANGLE_X)
    );
    // Adjust Y based on desired height
    camera.position.y = cameraDistance * 0.8; // Adjust this multiplier for height

    camera.rotation.order = 'YXZ'; // Set rotation order for intuitive angling
    camera.rotation.y = CAMERA_ANGLE_Y;
    camera.rotation.x = CAMERA_ANGLE_X;

    camera.lookAt(0, 0, 0); // Look at the center of the map initially
    scene.add(camera);

    // Lighting setup
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4); // Soft white ambient light
    scene.add(ambientLight);

    directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(MAP_SIZE / 4, MAP_SIZE / 2, MAP_SIZE / 4); // Initial position (e.g., morning sun)
    directionalLight.castShadow = true;
    directionalLight.target.position.set(0, 0, 0); // Target the center of the map

    // Shadow properties (adjust for performance vs quality)
    directionalLight.shadow.mapSize.width = 1024; // default 512
    directionalLight.shadow.mapSize.height = 1024; // default 512
    directionalLight.shadow.camera.near = 0.5;
    directionalLight.shadow.camera.far = MAP_SIZE * 1.5; // Needs to cover the map area
    // Adjust shadow camera frustum to cover the map
    const shadowCamSize = MAP_SIZE * TILE_SIZE / 1.5;
    directionalLight.shadow.camera.left = -shadowCamSize;
    directionalLight.shadow.camera.right = shadowCamSize;
    directionalLight.shadow.camera.top = shadowCamSize;
    directionalLight.shadow.camera.bottom = -shadowCamSize;

    scene.add(directionalLight);
    scene.add(directionalLight.target); // Add target to scene

    // --- Map Generation ---
    generateMap();

    // --- Event Listeners ---
    setupEventListeners();

    // Start the animation loop
    animate();
}

// --- Map Generation ---
function generateMap() {
    console.log(`Generating ${MAP_SIZE}x${MAP_SIZE} map... (This may take a while)`);
    mapGroup = new THREE.Group();
    const tileGeometry = new THREE.BoxGeometry(TILE_SIZE, TILE_SIZE, TILE_SIZE);
    const materials = {}; // Cache materials

    // Pre-create materials
    for (const typeName in TILE_TYPES) {
        const type = TILE_TYPES[typeName];
        materials[typeName] = new THREE.MeshStandardMaterial({ color: type.color });
        if (typeName === 'WATER') {
             materials[typeName].transparent = true;
             materials[typeName].opacity = 0.8;
        }
    }
    // Tree materials (simple)
    const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x8B4513 }); // SaddleBrown
    const leavesMaterial = new THREE.MeshStandardMaterial({ color: 0x006400 }); // DarkGreen

    const halfMapSize = (MAP_SIZE * TILE_SIZE) / 2;
    const treeProbability = 0.4; // Chance of a tree spawning on a GRASS_TREE tile

    for (let x = 0; x < MAP_SIZE; x++) {
        for (let z = 0; z < MAP_SIZE; z++) {
            // Calculate world position
            const worldX = (x * TILE_SIZE) - halfMapSize + TILE_SIZE / 2;
            const worldZ = (z * TILE_SIZE) - halfMapSize + TILE_SIZE / 2;

            // Get Perlin noise value (normalized 0 to 1)
            const noiseValue = (noiseGenerator.noise2D(x / NOISE_SCALE, z / NOISE_SCALE) + 1) / 2;

            // Determine tile type based on noise height
            let currentTileType = TILE_TYPES.WATER; // Default to lowest
            let material = materials.WATER;
            let elevation = TILE_TYPES.WATER.baseElevation;

            // Find the correct tile type (iterate from highest to lowest)
            const typeKeys = Object.keys(TILE_TYPES).sort((a, b) => TILE_TYPES[b].minHeight - TILE_TYPES[a].minHeight);
            for (const typeName of typeKeys) {
                if (noiseValue >= TILE_TYPES[typeName].minHeight) {
                    currentTileType = TILE_TYPES[typeName];
                    material = materials[typeName];
                    elevation = currentTileType.baseElevation;
                    break; // Found the highest applicable type
                }
            }

            // Create tile mesh
            const tileMesh = new THREE.Mesh(tileGeometry, material);
            tileMesh.position.set(worldX, elevation - TILE_SIZE / 2, worldZ); // Position base at elevation
            tileMesh.castShadow = true;
            tileMesh.receiveShadow = true;
            mapGroup.add(tileMesh);

            // Add tree if applicable
            if (currentTileType === TILE_TYPES.GRASS_TREE && Math.random() < treeProbability) {
                const trunkHeight = TILE_SIZE * 1.5;
                const leavesHeight = TILE_SIZE * 1.2;
                const trunkGeometry = new THREE.CylinderGeometry(TILE_SIZE * 0.1, TILE_SIZE * 0.15, trunkHeight, 6);
                const leavesGeometry = new THREE.ConeGeometry(TILE_SIZE * 0.5, leavesHeight, 8);

                const trunkMesh = new THREE.Mesh(trunkGeometry, trunkMaterial);
                const leavesMesh = new THREE.Mesh(leavesGeometry, leavesMaterial);

                trunkMesh.position.set(worldX, elevation + trunkHeight / 2, worldZ);
                leavesMesh.position.set(worldX, elevation + trunkHeight + leavesHeight / 2, worldZ);

                trunkMesh.castShadow = true;
                leavesMesh.castShadow = true;
                // trunkMesh.receiveShadow = false; // Trunk less likely to receive shadows well
                // leavesMesh.receiveShadow = true;

                mapGroup.add(trunkMesh);
                mapGroup.add(leavesMesh);
            }
        }
         // Provide progress update for large maps
        if (x % 100 === 0 && x > 0) {
             console.log(`Generated column ${x}/${MAP_SIZE}`);
        }
    }

    scene.add(mapGroup);
    console.log("Map generation complete.");
}


// --- Event Handling ---
function setupEventListeners() {
    const domElement = renderer.domElement;
    domElement.addEventListener('mousedown', onMouseDown, false);
    domElement.addEventListener('mousemove', onMouseMove, false);
    domElement.addEventListener('mouseup', onMouseUp, false);
    domElement.addEventListener('mouseleave', onMouseUp, false); // Treat leave as mouse up

    domElement.addEventListener('touchstart', onTouchStart, false);
    domElement.addEventListener('touchmove', onTouchMove, false);
    domElement.addEventListener('touchend', onTouchEnd, false);

    window.addEventListener('resize', onWindowResize, false);
}

function onMouseDown(event) {
    isDragging = true;
    previousMousePosition.x = event.clientX;
    previousMousePosition.y = event.clientY;
}

function onMouseMove(event) {
    if (!isDragging) return;

    const deltaX = event.clientX - previousMousePosition.x;
    const deltaY = event.clientY - previousMousePosition.y;

    moveCamera(deltaX, deltaY);

    previousMousePosition.x = event.clientX;
    previousMousePosition.y = event.clientY;
}

function onMouseUp() {
    isDragging = false;
}

// --- Touch Events ---
function onTouchStart(event) {
    if (event.touches.length === 1) { // Handle single touch for panning
        isDragging = true;
        previousMousePosition.x = event.touches[0].clientX;
        previousMousePosition.y = event.touches[0].clientY;
    }
}

function onTouchMove(event) {
    if (!isDragging || event.touches.length !== 1) return;

    const deltaX = event.touches[0].clientX - previousMousePosition.x;
    const deltaY = event.touches[0].clientY - previousMousePosition.y;

    moveCamera(deltaX, deltaY);

    previousMousePosition.x = event.touches[0].clientX;
    previousMousePosition.y = event.touches[0].clientY;
}

function onTouchEnd(event) {
     // Check if the touch ending is the one we were tracking
    if (isDragging && event.touches.length < 1) { // Or check changedTouches
        isDragging = false;
    }
}


// --- Camera Movement ---
function moveCamera(deltaX, deltaY) {
     // Calculate world units per pixel based on camera's current view height
    const worldUnitsPerPixel = (camera.top - camera.bottom) / window.innerHeight;

    // Calculate movement vectors based on camera's orientation projected onto the ground plane (XZ)
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0; // Project onto XZ plane
    forward.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(camera.up, forward).normalize(); // Camera's right vector projected onto XZ

    // Calculate the displacement vector
    // Moving mouse right (positive deltaX) should move camera left in world space (relative to screen)
    // Moving mouse down (positive deltaY) should move camera up in world space (relative to screen)
    const moveVector = new THREE.Vector3();
    moveVector.addScaledVector(right, deltaX * worldUnitsPerPixel);
    moveVector.addScaledVector(forward, deltaY * worldUnitsPerPixel); // Adjust if direction feels wrong

    // Apply the movement to the camera's position
    camera.position.add(moveVector);

    // --- Boundary Clamping ---
    clampCameraPosition();
}

function clampCameraPosition() {
    
}


// --- Window Resize ---
function onWindowResize() {
    const aspect = window.innerWidth / window.innerHeight;
    camera.left = CAMERA_FRUSTUM_SIZE * aspect / -2;
    camera.right = CAMERA_FRUSTUM_SIZE * aspect / 2;
    camera.top = CAMERA_FRUSTUM_SIZE / 2;
    camera.bottom = CAMERA_FRUSTUM_SIZE / -2;
    camera.updateProjectionMatrix(); // Important after changing frustum!

    renderer.setSize(window.innerWidth, window.innerHeight);
    clampCameraPosition(); // Re-clamp in case aspect ratio change affects boundary visibility
}


// --- Animation Loop ---
function animate() {
    requestAnimationFrame(animate); // Request next frame

    // Day/Night Cycle: Rotate the directional light
    const time = Date.now() * DAY_NIGHT_SPEED;
    const lightDistance = MAP_SIZE * 0.7; // Keep light orbiting outside the core map area
    directionalLight.position.x = Math.sin(time) * lightDistance;
    directionalLight.position.z = Math.cos(time) * lightDistance;
    // Optional: Vary height slightly for sunrise/sunset effect
    directionalLight.position.y = MAP_SIZE * 0.5 + Math.sin(time * 0.5) * MAP_SIZE * 0.2;
    directionalLight.target.position.set(0, 0, 0); // Keep targeting center

    // Render the scene
    renderer.render(scene, camera);
}

// --- Start the application ---
init();